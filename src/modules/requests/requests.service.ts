import { eq, and, ne, sql, desc, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  requests,
  dispatchTargets,
  offers,
  inventoryItems,
  inventoryMovements,
  jobs,
  jobStatusEvents,
  shops,
} from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { getIO } from '../../lib/socket.js';
import { notifyShop, notifyCustomer } from '../../lib/notify.js';
import { env } from '../../config/env.js';
import { ensureStripeCustomerForUser } from '../../lib/stripe-customers.js';
import { describeRepair, getDatasetQuote, assertCustomerPrice } from '../pricing/pricing.service.js';

async function notifyExpiredDispatches(
  dispatches: Array<{ id: string; shopId: string }>,
  requestId: string,
  message: string,
) {
  for (const dispatch of dispatches) {
    try {
      await notifyShop({
        shopId: dispatch.shopId,
        event: 'dispatch:expired',
        payload: {
          dispatchId: dispatch.id,
          requestId,
          status: 'EXPIRED',
          message,
        },
        push: {
          title: 'Request Closed',
          body: message,
          data: { screen: 'requests' },
        },
      });
    } catch {}
  }
}

// ─── [TEST] Simulate a customer creating a request ───

export async function createTestRequest(body: {
  deviceModelId: string;
  issueType: string;
  catalogVersion?: string;
  customerName: string;
  deviceBrand: string;
  deviceModel: string;
  issueDescription: string;
  photos?: string[];
  customerOfferCents: number;
  latitude?: string;
  longitude?: string;
  address?: string;
  shopId: string;
  distanceKm?: number;
}) {
  const quote = await getDatasetQuote(body);
  assertCustomerPrice(body.customerOfferCents, quote, body.catalogVersion);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

  // 1. Create the request
  const [request] = await db
    .insert(requests)
    .values({
      customerId: crypto.randomUUID(),
      customerName: body.customerName,
      deviceBrand: quote.deviceBrand,
      deviceModel: quote.deviceModel,
      deviceModelId: quote.deviceModelId,
      issueType: quote.issueType,
      priceSnapshot: quote.priceSnapshot,
      issueDescription: body.issueDescription,
      photos: body.photos ?? [],
      customerOfferCents: body.customerOfferCents,
      minPriceCents: quote.suggestedPriceCents,
      latitude: body.latitude ?? '40.7128',
      longitude: body.longitude ?? '-74.0060',
      address: body.address ?? '123 Main St, New York, NY',
      status: 'LIVE',
      expiresAt,
    })
    .returning();

  // 2. Dispatch to the shop
  const [dispatch] = await db
    .insert(dispatchTargets)
    .values({
      requestId: request.id,
      shopId: body.shopId,
      distanceKm: body.distanceKm ?? 2,
      status: 'SENT',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 min for test
    })
    .returning();

  // 3. Emit Socket.IO dispatch:popup for real-time
  try {
    await notifyShop({
      shopId: body.shopId,
      event: 'dispatch:popup',
      payload: {
        requestId: request.id,
        dispatchId: dispatch.id,
        deviceBrand: request.deviceBrand,
        deviceModel: request.deviceModel,
        issueDescription: request.issueDescription,
        customerOfferCents: request.customerOfferCents,
        minPriceCents: request.minPriceCents,
        suggestedPriceCents: request.minPriceCents,
        issueDisplayName: request.priceSnapshot?.issueDisplayName ?? (request.issueType ? describeRepair(request.issueType).displayName : null),
        distanceKm: body.distanceKm ?? 2,
        expiresAt: request.expiresAt?.toISOString(),
        photos: request.photos,
        customerName: request.customerName,
        createdAt: request.createdAt?.toISOString(),
      },
      push: {
        title: 'New Repair Request!',
        body: `${request.deviceBrand} ${request.deviceModel} — ${request.issueDescription}`,
        data: { screen: 'request-details', requestId: request.id, dispatchId: dispatch.id },
        channelId: 'dispatch',
        sound: 'noti_sound.wav',
      },
      persist: {
        category: 'dispatch',
        title: 'New Repair Request!',
        body: `${request.deviceBrand} ${request.deviceModel} — ${request.issueDescription}`,
        data: { screen: 'request-details', requestId: request.id, dispatchId: dispatch.id },
      },
    });
  } catch {
    // Socket.IO not critical
  }

  return {
    requestId: request.id,
    dispatchId: dispatch.id,
    expiresAt: request.expiresAt?.toISOString(),
  };
}

// ─── List requests for a shop ───

export async function listShopRequests(
  shopId: string,
  status: 'LIVE' | 'HISTORY',
  page: number,
  pageSize: number,
) {
  const offset = (page - 1) * pageSize;

  // For LIVE tab: only show actionable dispatch targets (SENT, SEEN, OFFERED)
  // For HISTORY tab: show everything else (DECLINED, EXPIRED, ACCEPTED, BOOKED...)
  const statusCondition =
    status === 'LIVE'
      ? and(
          sql`${requests.status} IN ('LIVE', 'DISPATCHING')`,
          sql`${requests.expiresAt} > now()`,
          sql`${dispatchTargets.status} IN ('SENT', 'SEEN', 'OFFERED')`,
        )
      : and(
          sql`(${requests.status} NOT IN ('LIVE', 'DISPATCHING') OR ${requests.expiresAt} <= now() OR ${dispatchTargets.status} IN ('DECLINED', 'EXPIRED', 'SKIPPED'))`,
          sql`${dispatchTargets.status} != 'PENDING'`,
        );

  // Count total for this shop + status
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dispatchTargets)
    .innerJoin(requests, eq(dispatchTargets.requestId, requests.id))
    .where(and(eq(dispatchTargets.shopId, shopId), statusCondition));

  // Fetch rows
  const rows = await db
    .select({
      requestId: requests.id,
      deviceBrand: requests.deviceBrand,
      deviceModel: requests.deviceModel,
      issueDescription: requests.issueDescription,
      issueType: requests.issueType,
      priceSnapshot: requests.priceSnapshot,
      customerOfferCents: requests.customerOfferCents,
      minPriceCents: requests.minPriceCents,
      photos: requests.photos,
      expiresAt: requests.expiresAt,
      createdAt: requests.createdAt,
      customerName: requests.customerName,
      dispatchStatus: dispatchTargets.status,
      distanceKm: dispatchTargets.distanceKm,
      dispatchExpiresAt: dispatchTargets.expiresAt,
    })
    .from(dispatchTargets)
    .innerJoin(requests, eq(dispatchTargets.requestId, requests.id))
    .where(and(eq(dispatchTargets.shopId, shopId), statusCondition))
    .orderBy(desc(requests.createdAt))
    .limit(pageSize)
    .offset(offset);

  return {
    data: rows.map((r) => ({
      requestId: r.requestId,
      device: `${r.deviceBrand} ${r.deviceModel}`,
      deviceBrand: r.deviceBrand,
      deviceModel: r.deviceModel,
      issue: r.issueDescription,
      customerOfferCents: r.customerOfferCents,
      minPriceCents: r.minPriceCents,
      suggestedPriceCents: r.minPriceCents,
      issueDisplayName: r.priceSnapshot?.issueDisplayName ?? (r.issueType ? describeRepair(r.issueType).displayName : null),
      distanceKm: r.distanceKm,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      dispatchExpiresAt: r.dispatchExpiresAt?.toISOString() ?? null,
      photos: r.photos ?? [],
      dispatchStatus: r.dispatchStatus,
      customerName: r.customerName,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
    total: count,
  };
}

// ─── Get single request (scoped to shop) ───

export async function getRequestForShop(requestId: string, shopId: string) {
  // Verify dispatch target exists and not SKIPPED
  const [dispatch] = await db
    .select()
    .from(dispatchTargets)
    .where(
      and(
        eq(dispatchTargets.requestId, requestId),
        eq(dispatchTargets.shopId, shopId),
        ne(dispatchTargets.status, 'SKIPPED'),
      ),
    )
    .limit(1);

  if (!dispatch) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Request not found or not dispatched to your shop');
  }

  const [request] = await db
    .select()
    .from(requests)
    .where(eq(requests.id, requestId))
    .limit(1);

  if (!request) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Request not found');
  }

  return {
    requestId: request.id,
    deviceBrand: request.deviceBrand,
    deviceModel: request.deviceModel,
    device: `${request.deviceBrand} ${request.deviceModel}`,
    issueDescription: request.issueDescription,
    photos: request.photos ?? [],
    customerOfferCents: request.customerOfferCents,
    minPriceCents: request.minPriceCents,
    suggestedPriceCents: request.minPriceCents,
    issueDisplayName: request.priceSnapshot?.issueDisplayName ?? (request.issueType ? describeRepair(request.issueType).displayName : null),
    customerName: request.customerName,
    latitude: request.latitude,
    longitude: request.longitude,
    address: request.address,
    status: request.status,
    expiresAt: request.expiresAt?.toISOString() ?? null,
    dispatchExpiresAt: dispatch.expiresAt?.toISOString() ?? null,
    createdAt: request.createdAt?.toISOString() ?? null,
    dispatchId: dispatch.id,
    dispatchStatus: dispatch.status,
    distanceKm: dispatch.distanceKm,
  };
}

// ─── Mark dispatch as SEEN ───

export async function markDispatchSeen(dispatchId: string, shopId: string) {
  const [dispatch] = await db
    .select()
    .from(dispatchTargets)
    .where(
      and(
        eq(dispatchTargets.id, dispatchId),
        eq(dispatchTargets.shopId, shopId),
      ),
    )
    .limit(1);

  if (!dispatch) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Dispatch target not found');
  }

  if (dispatch.status !== 'SENT') {
    // Already seen/offered/etc — just return
    return { dispatchId, status: dispatch.status };
  }

  const [updated] = await db
    .update(dispatchTargets)
    .set({ status: 'SEEN', seenAt: new Date() })
    .where(eq(dispatchTargets.id, dispatchId))
    .returning({ id: dispatchTargets.id, status: dispatchTargets.status });

  return { dispatchId: updated.id, status: updated.status };
}

// ─── Create offer ───

export async function createOffer(
  requestId: string,
  shopId: string,
  body: {
    priceCents: number;
    etaMinutes: number;
    warrantyDays: number;
    partsQuality: 'AFTERMARKET' | 'PREMIUM' | 'ORIGINAL';
    note?: string;
    reserveInventoryItemId?: string;
  },
) {
  // 1. Verify the request exists and is live
  const [request] = await db
    .select()
    .from(requests)
    .where(eq(requests.id, requestId))
    .limit(1);

  if (!request) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Request not found');
  }

  if (request.status !== 'LIVE' && request.status !== 'DISPATCHING') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Request is no longer available');
  }

  if (request.expiresAt && new Date(request.expiresAt) <= new Date()) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Request has expired');
  }

  // 2. Verify shop is dispatched to this request
  const [dispatch] = await db
    .select()
    .from(dispatchTargets)
    .where(
      and(
        eq(dispatchTargets.requestId, requestId),
        eq(dispatchTargets.shopId, shopId),
      ),
    )
    .limit(1);

  if (!dispatch) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Your shop is not dispatched to this request');
  }

  // 3. Validate price >= minPriceCents
  if (body.priceCents < request.minPriceCents) {
    throw new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Price must be at least ${request.minPriceCents} cents (suggested price)`,
    );
  }

  // 4. Check no existing active offer from this shop
  const [existingOffer] = await db
    .select({ id: offers.id })
    .from(offers)
    .where(
      and(
        eq(offers.requestId, requestId),
        eq(offers.shopId, shopId),
        inArray(offers.status, ['PENDING', 'ACCEPTED']),
      ),
    )
    .limit(1);

  if (existingOffer) {
    throw new AppError(409, ErrorCode.CONFLICT, 'You already have an active offer for this request');
  }

  // 5. Reserve inventory if requested
  if (body.reserveInventoryItemId) {
    // Use a raw UPDATE with WHERE qty available check for atomicity
    const result = await db
      .update(inventoryItems)
      .set({
        quantityReserved: sql`${inventoryItems.quantityReserved} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inventoryItems.id, body.reserveInventoryItemId),
          eq(inventoryItems.shopId, shopId),
          sql`${inventoryItems.quantity} - ${inventoryItems.quantityReserved} >= 1`,
        ),
      )
      .returning({ id: inventoryItems.id });

    if (result.length === 0) {
      throw new AppError(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Inventory item not found or insufficient quantity available',
      );
    }
  }

  // 6. Create the offer
  const [offer] = await db
    .insert(offers)
    .values({
      requestId,
      shopId,
      priceCents: body.priceCents,
      etaMinutes: body.etaMinutes,
      warrantyDays: body.warrantyDays,
      partsQuality: body.partsQuality,
      note: body.note ?? null,
      status: 'PENDING',
      reserveInventoryItemId: body.reserveInventoryItemId ?? null,
      expiresAt: null,
    })
    .returning();

  // 7. Update dispatch_targets status to OFFERED
  await db
    .update(dispatchTargets)
    .set({ status: 'OFFERED' })
    .where(
      and(
        eq(dispatchTargets.requestId, requestId),
        eq(dispatchTargets.shopId, shopId),
      ),
    );

  // 8. Create inventory movement if reserved
  if (body.reserveInventoryItemId) {
    await db.insert(inventoryMovements).values({
      inventoryItemId: body.reserveInventoryItemId,
      type: 'RESERVED',
      quantity: 1,
      referenceId: offer.id,
    });
  }

  // 9. Emit Socket.IO events (enriched with shop info for real-time display)
  try {
    const io = getIO();

    // Fetch shop name + completed jobs for enriched payload
    const [shopInfo] = await db
      .select({ name: shops.name, logoUrl: shops.logoUrl })
      .from(shops)
      .where(eq(shops.id, shopId))
      .limit(1);

    const [completedCount] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(jobs)
      .where(and(eq(jobs.shopId, shopId), eq(jobs.status, 'COMPLETED')));

    const offerPayload = {
      offerId: offer.id,
      requestId,
      shopId,
      shopName: shopInfo?.name ?? 'Shop',
      shopLogoUrl: shopInfo?.logoUrl ?? null,
      shopCompletedJobs: completedCount?.count ?? 0,
      priceCents: offer.priceCents,
      etaMinutes: offer.etaMinutes,
      warrantyDays: offer.warrantyDays,
      partsQuality: offer.partsQuality,
      status: offer.status,
      expiresAt: offer.expiresAt?.toISOString() ?? null,
      createdAt: offer.createdAt?.toISOString() ?? null,
    };
    io.to(`shop:${shopId}`).emit('offer:created', offerPayload);
    io.to(`request:${requestId}`).emit('offer:created', offerPayload);
    // Also emit to customer room so request list refreshes
    await notifyCustomer({
      customerId: request.customerId,
      event: 'offer:created',
      payload: offerPayload,
      push: { title: 'New Offer Received!', body: `A shop sent you an offer for your repair.`, data: { screen: 'request-detail', requestId } },
      persist: {
        category: 'offer',
        title: 'New Offer Received!',
        body: 'A shop sent you an offer for your repair.',
        data: { screen: 'request-detail', requestId },
      },
    });
  } catch {
    // Socket.IO not critical
  }

  return {
    offerId: offer.id,
    requestId: offer.requestId,
    shopId: offer.shopId,
    priceCents: offer.priceCents,
    etaMinutes: offer.etaMinutes,
    warrantyDays: offer.warrantyDays,
    partsQuality: offer.partsQuality,
    note: offer.note,
    status: offer.status,
    expiresAt: offer.expiresAt?.toISOString() ?? null,
    createdAt: offer.createdAt?.toISOString() ?? null,
  };
}

// ─── [TEST] Simulate customer accepting an offer ───

export async function customerAcceptOffer(offerId: string) {
  // ── Stripe: create PaymentIntent (hold) ──
  let stripePaymentIntentId: string | null = null;
  let platformFeeCents = 0;

  const result = await db.transaction(async (tx) => {
    // 1. Get the offer
    const [offer] = await tx
      .select()
      .from(offers)
      .where(eq(offers.id, offerId))
      .limit(1);

    if (!offer) throw new AppError(404, ErrorCode.NOT_FOUND, 'Offer not found');
    if (offer.status !== 'PENDING') {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR, `Offer is already ${offer.status}`);
    }

    // 2. Get the request
    const [request] = await tx
      .select()
      .from(requests)
      .where(eq(requests.id, offer.requestId))
      .limit(1);

    if (!request) throw new AppError(404, ErrorCode.NOT_FOUND, 'Request not found');
    if (request.status !== 'LIVE' && request.status !== 'DISPATCHING') {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR, `Request is ${request.status}, cannot accept offers`);
    }

    // 3. Get shop's Stripe Connect account
    const [shop] = await tx
      .select({ stripeAccountId: shops.stripeAccountId })
      .from(shops)
      .where(eq(shops.id, offer.shopId))
      .limit(1);

    const shopStripeAccountId = shop?.stripeAccountId ?? null;

    // 4. Calculate 5% platform fee
    platformFeeCents = Math.round(offer.priceCents * 0.05);

    // 5. Create Stripe PaymentIntent with manual capture (hold the money)
    if (env.STRIPE_SECRET_KEY) {
      try {
        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(env.STRIPE_SECRET_KEY);

        const stripeCustomerId = await ensureStripeCustomerForUser(stripe, request.customerId);
        const stripeCustomer = await stripe.customers.retrieve(stripeCustomerId);
        if (stripeCustomer.deleted) {
          throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Customer Stripe profile is unavailable');
        }
        const defaultPmId = (stripeCustomer as any).invoice_settings?.default_payment_method ?? null;
        let paymentMethodId = typeof defaultPmId === 'string' ? defaultPmId : null;
        if (!paymentMethodId) {
          const pms = await stripe.paymentMethods.list({
            customer: stripeCustomerId,
            type: 'card',
            limit: 1,
          });
          paymentMethodId = pms.data[0]?.id ?? null;
        }
        if (!paymentMethodId) {
          throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Customer has no saved card');
        }

        const piParams: any = {
          amount: offer.priceCents,
          currency: 'usd',
          capture_method: 'manual', // authorize only, capture later
          customer: stripeCustomerId,
          payment_method: paymentMethodId,
          off_session: true,
          confirm: true, // immediately confirm
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          metadata: {
            offerId: offer.id,
            requestId: request.id,
            shopId: offer.shopId,
            customerId: request.customerId,
            customerName: request.customerName,
          },
        };

        // NOTE: We do NOT use destination charges (transfer_data).
        // Money stays on platform. We create an explicit Transfer when the
        // customer confirms or the 24-hour hold expires. This lets us control
        // exactly when funds land on the Connect account.

        const paymentIntent = await stripe.paymentIntents.create(piParams);
        stripePaymentIntentId = paymentIntent.id;
        console.log(`💳 PaymentIntent created: ${paymentIntent.id} ($${(offer.priceCents / 100).toFixed(2)}) — status: ${paymentIntent.status}`);
      } catch (err: any) {
        console.error('⚠️ Stripe PaymentIntent creation failed:', err.message);
        // Continue without Stripe — still create the job
        stripePaymentIntentId = `pi_mock_${Date.now()}`;
      }
    } else {
      stripePaymentIntentId = `pi_mock_${Date.now()}`;
    }

    // 6. Accept the offer
    await tx
      .update(offers)
      .set({ status: 'ACCEPTED', updatedAt: new Date() })
      .where(eq(offers.id, offerId));

    // 7. Expire all other pending offers for this request and release their reservations
    const competingOffers = await tx
      .select({
        id: offers.id,
        shopId: offers.shopId,
        reserveInventoryItemId: offers.reserveInventoryItemId,
      })
      .from(offers)
      .where(
        and(
          eq(offers.requestId, request.id),
          ne(offers.id, offerId),
          eq(offers.status, 'PENDING'),
        ),
      );

    await tx
      .update(offers)
      .set({ status: 'EXPIRED', updatedAt: new Date() })
      .where(
        and(
          eq(offers.requestId, request.id),
          ne(offers.id, offerId),
          eq(offers.status, 'PENDING'),
        ),
      );

    for (const competingOffer of competingOffers) {
      if (!competingOffer.reserveInventoryItemId) continue;

      await tx
        .update(inventoryItems)
        .set({
          quantityReserved: sql`GREATEST(0, ${inventoryItems.quantityReserved} - 1)`,
          updatedAt: new Date(),
        })
        .where(eq(inventoryItems.id, competingOffer.reserveInventoryItemId));

      await tx.insert(inventoryMovements).values({
        inventoryItemId: competingOffer.reserveInventoryItemId,
        type: 'RELEASED',
        quantity: 1,
        referenceId: competingOffer.id,
        note: 'Released because another shop was accepted first.',
      });
    }

    // 8. Expire every other active dispatch and skip any still waiting in the queue.
    const expiredDispatches = await tx
      .update(dispatchTargets)
      .set({ status: 'EXPIRED', expiresAt: new Date() })
      .where(
        and(
          eq(dispatchTargets.requestId, request.id),
          ne(dispatchTargets.shopId, offer.shopId),
          inArray(dispatchTargets.status, ['SENT', 'SEEN', 'OFFERED']),
        ),
      )
      .returning({
        id: dispatchTargets.id,
        shopId: dispatchTargets.shopId,
      });

    await tx
      .update(dispatchTargets)
      .set({ status: 'SKIPPED', expiresAt: new Date() })
      .where(
        and(
          eq(dispatchTargets.requestId, request.id),
          ne(dispatchTargets.shopId, offer.shopId),
          eq(dispatchTargets.status, 'PENDING'),
        ),
      );

    // Mark the offering shop's dispatch as ACCEPTED
    await tx
      .update(dispatchTargets)
      .set({ status: 'ACCEPTED' })
      .where(
        and(
          eq(dispatchTargets.requestId, request.id),
          eq(dispatchTargets.shopId, offer.shopId),
        ),
      );

    // 9. Mark request as BOOKED
    await tx
      .update(requests)
      .set({ status: 'BOOKED', updatedAt: new Date() })
      .where(eq(requests.id, request.id));

    // 10. Create the job
    const [job] = await tx
      .insert(jobs)
      .values({
        requestId: request.id,
        offerId: offer.id,
        shopId: offer.shopId,
        customerId: request.customerId,
        customerName: request.customerName,
        deviceBrand: request.deviceBrand,
        deviceModel: request.deviceModel,
        issueDescription: request.issueDescription,
        priceCents: offer.priceCents,
        etaMinutes: offer.etaMinutes,
        warrantyDays: offer.warrantyDays,
        partsQuality: offer.partsQuality,
        customerInitialVideoUrl: request.videoUrl ?? null,
        status: 'BOOKED',
        paymentStatus: 'HELD',
        stripePaymentIntentId,
        platformFeeCents,
      })
      .returning();

    // 11. Create initial status event
    await tx.insert(jobStatusEvents).values({
      jobId: job.id,
      fromStatus: null,
      toStatus: 'BOOKED',
      note: `Job created — customer accepted offer. Payment held: $${(offer.priceCents / 100).toFixed(2)} (fee: $${(platformFeeCents / 100).toFixed(2)})`,
    });

    // 12. Auto-adjust inventory
    if (offer.reserveInventoryItemId) {
      await tx
        .update(inventoryItems)
        .set({
          quantityReserved: sql`GREATEST(0, ${inventoryItems.quantityReserved} - 1)`,
          quantity: sql`GREATEST(0, ${inventoryItems.quantity} - 1)`,
          updatedAt: new Date(),
        })
        .where(eq(inventoryItems.id, offer.reserveInventoryItemId));

      await tx.insert(inventoryMovements).values({
        inventoryItemId: offer.reserveInventoryItemId,
        type: 'USED',
        quantity: -1,
        referenceId: job.id,
        note: `Used for job – ${request.deviceBrand} ${request.deviceModel}`,
      });
    }

    return {
      jobId: job.id,
      offerId: offer.id,
      requestId: request.id,
      shopId: offer.shopId,
      customerName: request.customerName,
      deviceModel: request.deviceModel,
      priceCents: offer.priceCents,
      platformFeeCents,
      netAmountCents: offer.priceCents - platformFeeCents,
      stripePaymentIntentId,
      expiredDispatches,
      status: 'BOOKED',
    };
  });

  // Emit Socket.IO events
  try {
    await notifyShop({
      shopId: result.shopId,
      event: 'offer:accepted',
      payload: { offerId: result.offerId, requestId: result.requestId, jobId: result.jobId },
      push: { title: 'Offer Accepted!', body: 'A customer accepted your offer.', data: { screen: 'job-details', jobId: result.jobId } },
      persist: {
        category: 'offer',
        title: 'Offer Accepted!',
        body: 'A customer accepted your offer.',
        data: { screen: 'job-details', jobId: result.jobId },
      },
    });
    await notifyShop({
      shopId: result.shopId,
      event: 'job:created',
      payload: { jobId: result.jobId, requestId: result.requestId },
    });
    await notifyExpiredDispatches(
      result.expiredDispatches,
      result.requestId,
      'This request is no longer available because the customer accepted another shop.',
    );
  } catch {}

  return result;
}

// ─── [TEST] Find nearby approved shops for customer ───

export async function findNearbyShops(lat: number, lng: number, radiusKm = 50) {
  const rows = await db
    .select({
      id: shops.id,
      name: shops.name,
      address: shops.address,
      city: shops.city,
      state: shops.state,
      latitude: shops.latitude,
      longitude: shops.longitude,
      serviceRadius: shops.serviceRadius,
      categories: shops.categories,
      logoUrl: shops.logoUrl,
      vacationMode: shops.vacationMode,
    })
    .from(shops)
    .where(eq(shops.onboardingStatus, 'APPROVED'));

  // Filter by distance (Haversine)
  return rows
    .filter((s) => {
      if (!s.latitude || !s.longitude) return false;
      const d = haversineKm(lat, lng, parseFloat(s.latitude), parseFloat(s.longitude));
      return d <= radiusKm + 1e-9;
    })
    .map((s) => ({
      ...s,
      isOnline: !s.vacationMode,
      distanceKm: haversineKm(lat, lng, parseFloat(s.latitude!), parseFloat(s.longitude!)),
    }))
    .sort((a, b) => {
      if (a.isOnline !== b.isOnline) {
        return a.isOnline ? -1 : 1;
      }
      return a.distanceKm - b.distanceKm;
    });
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── [TEST] Get offers for a request (customer view) ───

export async function getOffersForRequest(requestId: string) {
  const rows = await db
    .select({
      offerId: offers.id,
      shopId: offers.shopId,
      shopName: shops.name,
      priceCents: offers.priceCents,
      etaMinutes: offers.etaMinutes,
      warrantyDays: offers.warrantyDays,
      partsQuality: offers.partsQuality,
      note: offers.note,
      status: offers.status,
      expiresAt: offers.expiresAt,
      createdAt: offers.createdAt,
    })
    .from(offers)
    .innerJoin(shops, eq(shops.id, offers.shopId))
    .where(eq(offers.requestId, requestId))
    .orderBy(desc(offers.createdAt));

  return rows.map((r) => ({
    ...r,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt?.toISOString() ?? null,
  }));
}

// ─── [TEST] Get request status + job info (customer view) ───

export async function getRequestStatus(requestId: string) {
  const [request] = await db
    .select()
    .from(requests)
    .where(eq(requests.id, requestId))
    .limit(1);

  if (!request) throw new AppError(404, ErrorCode.NOT_FOUND, 'Request not found');

  // Check if there's a job
  const [job] = await db
    .select({
      jobId: jobs.id,
      status: jobs.status,
      paymentStatus: jobs.paymentStatus,
      shopId: jobs.shopId,
      completedAt: jobs.completedAt,
    })
    .from(jobs)
    .where(eq(jobs.requestId, requestId))
    .limit(1);

  // Get shop name if job exists
  let shopName: string | null = null;
  if (job) {
    const [shop] = await db
      .select({ name: shops.name })
      .from(shops)
      .where(eq(shops.id, job.shopId))
      .limit(1);
    shopName = shop?.name ?? null;
  }

  return {
    requestId: request.id,
    customerName: request.customerName,
    deviceBrand: request.deviceBrand,
    deviceModel: request.deviceModel,
    issueDescription: request.issueDescription,
    customerOfferCents: request.customerOfferCents,
    status: request.status,
    expiresAt: request.expiresAt?.toISOString() ?? null,
    createdAt: request.createdAt?.toISOString() ?? null,
    job: job
      ? {
          jobId: job.jobId,
          status: job.status,
          paymentStatus: job.paymentStatus,
          shopName,
          completedAt: job.completedAt?.toISOString() ?? null,
        }
      : null,
  };
}
