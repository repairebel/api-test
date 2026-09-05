import { eq, and, ne, not, ilike, sql, inArray, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  deviceModels,
  requests,
  users,
  shops,
  systemSettings,
  inventoryItems,
  inventoryMovements,
  offers,
  dispatchTargets,
  jobs,
  jobStatusEvents,
  jobMedia,
  payouts,
  reviews,
} from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { generateCloudinarySignature } from '../media/media.service.js';
import {
  startDispatch,
  dispatchNextShop,
  notifyExpiredDispatches,
} from '../dispatch/dispatch.service.js';
import { getDatasetQuote, assertCustomerPrice, supportedModelCondition, describeRepair } from '../pricing/pricing.service.js';
import { getIO } from '../../lib/socket.js';
import { notifyShop, notifyCustomer } from '../../lib/notify.js';
import { sendOrderBookingConfirmationEmail } from '../../lib/email.js';
import { ensureStripeCustomerForUser } from '../../lib/stripe-customers.js';
import { env } from '../../config/env.js';

const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

async function releaseReservedOffers(
  tx: any,
  expiringOffers: Array<{ id: string; reserveInventoryItemId: string | null }>,
  note: string,
) {
  for (const expiringOffer of expiringOffers) {
    if (!expiringOffer.reserveInventoryItemId) continue;

    await tx
      .update(inventoryItems)
      .set({
        quantityReserved: sql`GREATEST(0, ${inventoryItems.quantityReserved} - 1)`,
        updatedAt: new Date(),
      })
      .where(eq(inventoryItems.id, expiringOffer.reserveInventoryItemId));

    await tx.insert(inventoryMovements).values({
      inventoryItemId: expiringOffer.reserveInventoryItemId,
      type: 'RELEASED',
      quantity: 1,
      referenceId: expiringOffer.id,
      note,
    });
  }
}

async function expireCompetingMarketplaceState(
  tx: any,
  requestId: string,
  acceptedOfferId: string,
  acceptedShopId: string,
) {
  const competingOffers = await tx
    .select({
      id: offers.id,
      reserveInventoryItemId: offers.reserveInventoryItemId,
    })
    .from(offers)
    .where(
      and(
        eq(offers.requestId, requestId),
        ne(offers.id, acceptedOfferId),
        eq(offers.status, 'PENDING'),
      ),
    );

  await tx
    .update(offers)
    .set({ status: 'EXPIRED', updatedAt: new Date() })
    .where(
      and(
        eq(offers.requestId, requestId),
        ne(offers.id, acceptedOfferId),
        eq(offers.status, 'PENDING'),
      ),
    );

  await releaseReservedOffers(
    tx,
    competingOffers,
    'Released because another shop was accepted first.',
  );

  const expiredDispatches = await tx
    .update(dispatchTargets)
    .set({ status: 'EXPIRED', expiresAt: new Date() })
    .where(
      and(
        eq(dispatchTargets.requestId, requestId),
        ne(dispatchTargets.shopId, acceptedShopId),
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
        eq(dispatchTargets.requestId, requestId),
        ne(dispatchTargets.shopId, acceptedShopId),
        eq(dispatchTargets.status, 'PENDING'),
      ),
    );

  return expiredDispatches;
}

async function getOrderCommissionPercent(): Promise<number> {
  const [settings] = await db
    .select({ commissionPercent: systemSettings.commissionPercent })
    .from(systemSettings)
    .where(eq(systemSettings.id, SETTINGS_ID))
    .limit(1);

  const percent = settings?.commissionPercent ?? 5;
  return Math.max(0, Math.min(100, percent));
}

// ─── Device Model Search ───

export async function searchDeviceModels(
  query: string,
  brand?: string,
  limit = 100,
  supportedOnly = true,
) {
  const conditions = [];
  if (supportedOnly) conditions.push(supportedModelCondition());

  if (brand) {
    conditions.push(ilike(deviceModels.brand, brand));
  }

  if (query.trim()) {
    conditions.push(ilike(deviceModels.modelName, `%${query.trim()}%`));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: deviceModels.id,
      brand: deviceModels.brand,
      modelName: deviceModels.modelName,
      modelNumber: deviceModels.modelNumber,
      deviceType: deviceModels.deviceType,
    })
    .from(deviceModels)
    .where(where)
    .orderBy(deviceModels.brand, deviceModels.modelName)
    .limit(limit);

  return rows;
}

export async function getDistinctBrands() {
  const rows = await db
    .selectDistinct({ brand: deviceModels.brand })
    .from(deviceModels)
    .orderBy(deviceModels.brand);

  return rows.map((r) => r.brand);
}

// ─── Customer Cloudinary Signature ───

export function getCustomerMediaSignature(
  customerId: string,
  resourceType: 'image' | 'video',
  tempId?: string,
) {
  const entityId = `${customerId}/${tempId || 'draft'}`;

  // We extend the existing generateCloudinarySignature with REQUEST_MEDIA context
  // by calling it with a custom signature params
  return generateCustomerSignature(entityId, resourceType);
}

function generateCustomerSignature(
  entityId: string,
  resourceType: 'image' | 'video',
) {
  // Reuse the core Cloudinary signature logic
  // The context 'REQUEST_MEDIA' maps to folder: requests/{entityId}
  return generateCloudinarySignature({
    context: 'REQUEST_MEDIA' as any,
    entityId,
    resourceType,
  });
}

// ─── Create Customer Request ───

interface CreateCustomerRequestInput {
  customPartName?: string;
  deviceModelId: string;
  catalogVersion?: string;
  deviceBrand: string;
  deviceModel: string;
  issueType: string;
  issueDescription?: string;
  photos: string[];
  videoUrl?: string;
  customerOfferCents: number;
  latitude: string;
  longitude: string;
  address: string;
  dispatchRadiusMiles: number;
}

export async function createCustomerRequest(
  customerId: string,
  input: CreateCustomerRequestInput,
) {
  const dispatchRadiusMiles = Math.max(1, Math.min(90, input.dispatchRadiusMiles));
  const customerMaxDistanceKm = dispatchRadiusMiles * 1.60934;

  // 1. Get customer name
  const [user] = await db
    .select({ fullName: users.fullName })
    .from(users)
    .where(eq(users.id, customerId))
    .limit(1);

  if (!user) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');
  }

  const customerName = user.fullName || 'Customer';

  // Recompute from the authoritative model/repair catalog at submission time.
  const quote = await getDatasetQuote(input);
  assertCustomerPrice(input.customerOfferCents, quote, input.catalogVersion);
  const { minPriceCents } = quote;

  // 4. Create the request
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

  const [request] = await db
    .insert(requests)
    .values({
      customerId,
      customerName,
      deviceBrand: quote.deviceBrand,
      deviceModel: quote.deviceModel,
      deviceModelId: quote.deviceModelId,
      priceSnapshot: quote.priceSnapshot,
      issueType: input.issueType,
      issueDescription: input.issueDescription || '',
      photos: input.photos,
      videoUrl: input.videoUrl ?? null,
      customerOfferCents: input.customerOfferCents,
      minPriceCents,
      latitude: input.latitude,
      longitude: input.longitude,
      address: input.address,
      status: 'LIVE',
      expiresAt,
    })
    .returning();

  // 5. Start dispatch (Uber-like cascade)
  let dispatchResult;
  try {
    dispatchResult = await startDispatch(request.id, { customerMaxDistanceKm });
  } catch (err: any) {
    // If dispatch fails (e.g., no shops), the request still exists
    // It will show as EXPIRED to the customer
    console.error('Dispatch failed for request', request.id, err.message);
  }

  // Re-fetch request status (dispatch may have changed it to EXPIRED)
  const [updated] = await db
    .select({ status: requests.status })
    .from(requests)
    .where(eq(requests.id, request.id))
    .limit(1);

  return {
    requestId: request.id,
    status: updated?.status ?? request.status,
    minPriceCents,
    suggestedPriceCents: minPriceCents,
    catalogVersion: quote.catalogVersion,
    customerOfferCents: input.customerOfferCents,
    expiresAt: request.expiresAt.toISOString(),
    dispatch: dispatchResult ?? null,
  };
}

// ─── List Customer Requests ───

export async function listCustomerRequests(
  customerId: string,
  status: 'ACTIVE' | 'HISTORY',
  page: number,
  pageSize: number,
) {
  const offset = (page - 1) * pageSize;

  const activeStatuses = ['LIVE', 'DISPATCHING', 'OFFERED', 'ACCEPTED'];
  const historyStatuses = ['BOOKED', 'EXPIRED', 'CANCELLED'];

  const statusFilter =
    status === 'ACTIVE'
      ? inArray(requests.status, activeStatuses as any)
      : inArray(requests.status, historyStatuses as any);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(requests)
    .where(and(eq(requests.customerId, customerId), statusFilter));

  const total = Number(countResult?.count ?? 0);

  const rows = await db
    .select()
    .from(requests)
    .where(and(eq(requests.customerId, customerId), statusFilter))
    .orderBy(sql`${requests.createdAt} DESC`)
    .limit(pageSize)
    .offset(offset);

  const data = rows.map((r) => ({
    id: r.id,
    deviceBrand: r.deviceBrand,
    deviceModel: r.deviceModel,
    issueType: r.issueType,
    issueDescription: r.issueDescription,
    photos: r.photos,
    videoUrl: r.videoUrl,
    customerOfferCents: r.customerOfferCents,
    minPriceCents: r.minPriceCents,
    suggestedPriceCents: r.minPriceCents,
    issueDisplayName: r.priceSnapshot?.issueDisplayName ?? describeRepair(r.issueType ?? 'OTHER').displayName,
    issueIcon: describeRepair(r.issueType ?? 'OTHER').icon,
    latitude: r.latitude,
    longitude: r.longitude,
    address: r.address,
    status: r.status,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt?.toISOString() ?? null,
  }));

  return { data, total };
}

// ─── Get Customer Request Detail ───

export async function getCustomerRequestDetail(
  requestId: string,
  customerId: string,
) {
  const [request] = await db
    .select()
    .from(requests)
    .where(and(eq(requests.id, requestId), eq(requests.customerId, customerId)))
    .limit(1);

  if (!request) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Request not found');
  }

  // Get offers for this request (with shop enrichment)
  const requestOffers = await db
    .select({
      id: offers.id,
      shopId: offers.shopId,
      priceCents: offers.priceCents,
      etaMinutes: offers.etaMinutes,
      warrantyDays: offers.warrantyDays,
      partsQuality: offers.partsQuality,
      note: offers.note,
      status: offers.status,
      expiresAt: offers.expiresAt,
      createdAt: offers.createdAt,
      shopName: shops.name,
      shopLogoUrl: shops.logoUrl,
    })
    .from(offers)
    .leftJoin(shops, eq(offers.shopId, shops.id))
    .where(eq(offers.requestId, requestId))
    .orderBy(sql`${offers.createdAt} DESC`);

  // Get distance from dispatch_targets for each shop
  const distances = await db
    .select({
      shopId: dispatchTargets.shopId,
      distanceKm: dispatchTargets.distanceKm,
    })
    .from(dispatchTargets)
    .where(eq(dispatchTargets.requestId, requestId));
  const distanceMap = new Map(distances.map((d) => [d.shopId, d.distanceKm]));

  // Get completed-job counts per shop
  const shopIds = [...new Set(requestOffers.map((o) => o.shopId))];
  let completedMap = new Map<string, number>();
  if (shopIds.length > 0) {
    const counts = await db
      .select({
        shopId: jobs.shopId,
        count: sql<number>`count(*)::int`,
      })
      .from(jobs)
      .where(and(inArray(jobs.shopId, shopIds), eq(jobs.status, 'COMPLETED')))
      .groupBy(jobs.shopId);
    completedMap = new Map(counts.map((c) => [c.shopId, c.count]));
  }

  // Get live rating + visible review count per shop
  let ratingMap = new Map<string, { avgRating: number; totalReviews: number }>();
  if (shopIds.length > 0) {
    const ratingRows = await db
      .select({
        shopId: reviews.shopId,
        avgRating: sql<number>`coalesce(round(avg(${reviews.rating})::numeric, 1), 0)`,
        totalReviews: sql<number>`count(*)::int`,
      })
      .from(reviews)
      .where(and(inArray(reviews.shopId, shopIds), eq(reviews.isHidden, false)))
      .groupBy(reviews.shopId);

    ratingMap = new Map(
      ratingRows.map((row) => [
        row.shopId,
        {
          avgRating: Number(row.avgRating ?? 0),
          totalReviews: Number(row.totalReviews ?? 0),
        },
      ]),
    );
  }

  // Get job if booked
  const [job] = await db
    .select({
      id: jobs.id,
      status: jobs.status,
      shopName: shops.name,
    })
    .from(jobs)
    .leftJoin(shops, eq(jobs.shopId, shops.id))
    .where(eq(jobs.requestId, requestId))
    .limit(1);

  return {
    id: request.id,
    customerId: request.customerId,
    deviceBrand: request.deviceBrand,
    deviceModel: request.deviceModel,
    issueType: request.issueType,
    issueDescription: request.issueDescription,
    photos: request.photos,
    videoUrl: request.videoUrl,
    customerOfferCents: request.customerOfferCents,
    minPriceCents: request.minPriceCents,
    suggestedPriceCents: request.minPriceCents,
    issueDisplayName: request.priceSnapshot?.issueDisplayName ?? describeRepair(request.issueType ?? 'OTHER').displayName,
    issueIcon: describeRepair(request.issueType ?? 'OTHER').icon,
    latitude: request.latitude,
    longitude: request.longitude,
    address: request.address,
    status: request.status,
    expiresAt: request.expiresAt?.toISOString() ?? null,
    createdAt: request.createdAt?.toISOString() ?? null,
    offers: requestOffers.map((o) => ({
      id: o.id,
      shopId: o.shopId,
      shopName: o.shopName,
      shopLogoUrl: o.shopLogoUrl ?? null,
      shopDistanceKm: distanceMap.get(o.shopId) ?? null,
      shopRating: ratingMap.get(o.shopId)?.avgRating ?? 0,
      shopReviewCount: ratingMap.get(o.shopId)?.totalReviews ?? 0,
      shopCompletedJobs: completedMap.get(o.shopId) ?? 0,
      priceCents: o.priceCents,
      etaMinutes: o.etaMinutes,
      warrantyDays: o.warrantyDays,
      partsQuality: o.partsQuality,
      note: o.note,
      status: o.status,
      expiresAt: o.expiresAt?.toISOString() ?? null,
      createdAt: o.createdAt?.toISOString() ?? null,
    })),
    job: job
      ? { id: job.id, status: job.status, shopName: job.shopName }
      : null,
  };
}

// ─── Price Estimate (lightweight, no auth required in principle) ───

export const getPriceEstimate = getDatasetQuote;

// ─── Accept Offer ───

export async function acceptOffer(offerId: string, customerId: string) {
  let stripePaymentIntentId: string | null = null;
  let platformFeeCents = 0;
  let requiresAction = false;
  let paymentClientSecret: string | null = null;
  let customerEmail: string | null = null;
  let customerFullName: string | null = null;

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

    // 2. Get the request & verify ownership
    const [request] = await tx
      .select()
      .from(requests)
      .where(eq(requests.id, offer.requestId))
      .limit(1);

    if (!request) throw new AppError(404, ErrorCode.NOT_FOUND, 'Request not found');
    if (request.customerId !== customerId) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'Not your request');
    }
    if (request.status !== 'LIVE' && request.status !== 'DISPATCHING') {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR, `Request is ${request.status}, cannot accept offers`);
    }

    // 3. Get shop's Stripe Connect account
    const [shop] = await tx
      .select({ stripeAccountId: shops.stripeAccountId, name: shops.name })
      .from(shops)
      .where(eq(shops.id, offer.shopId))
      .limit(1);

    // 4. Calculate platform fee from admin settings
    const commissionPercent = await getOrderCommissionPercent();
    platformFeeCents = Math.round(offer.priceCents * (commissionPercent / 100));

    // 4b. Get customer's Stripe customer ID and default payment method
    const [customerUser] = await tx
      .select({ stripeCustomerId: users.stripeCustomerId, email: users.email, fullName: users.fullName })
      .from(users)
      .where(eq(users.id, customerId))
      .limit(1);

    customerEmail = customerUser?.email ?? null;
    customerFullName = customerUser?.fullName ?? null;

    // 5. Create Stripe PaymentIntent with manual capture
    if (env.STRIPE_SECRET_KEY) {
      try {
        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(env.STRIPE_SECRET_KEY);
        const stripeCustomerId = await ensureStripeCustomerForUser(stripe, customerId);

        // Look up the customer's default payment method from Stripe
        const stripeCustomer = await stripe.customers.retrieve(stripeCustomerId);
        if (stripeCustomer.deleted) {
          throw new AppError(400, ErrorCode.VALIDATION_ERROR,
            'Your payment profile was removed. Please add a card in Settings → Payment Methods.');
        }
        const defaultPmId = (stripeCustomer as any).invoice_settings?.default_payment_method ?? null;
        let paymentMethodId: string;
        if (!defaultPmId) {
          const pms = await stripe.paymentMethods.list({
            customer: stripeCustomerId,
            type: 'card',
            limit: 1,
          });
          if (!pms.data.length) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR,
              'No payment method on file. Please add a card in Settings → Payment Methods before accepting an offer.');
          }
          paymentMethodId = pms.data[0].id;
        } else {
          paymentMethodId = defaultPmId as string;
        }

        const piMetadata = {
          offerId: offer.id,
          requestId: request.id,
          shopId: offer.shopId,
          customerId,
          customerName: request.customerName,
        };

        // Try off-session first (no 3DS challenge needed)
        try {
          const paymentIntent = await stripe.paymentIntents.create({
            amount: offer.priceCents,
            currency: 'usd',
            capture_method: 'manual',
            customer: stripeCustomerId,
            payment_method: paymentMethodId,
            off_session: true,
            confirm: true,
            automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
            metadata: piMetadata,
          }, { idempotencyKey: `offer-${offer.id}-authorization` });
          stripePaymentIntentId = paymentIntent.id;
        } catch (piErr: any) {
          if (piErr.code === 'authentication_required') {
            // Card requires 3DS — create AND confirm on-session PI so it enters requires_action
            const onSessionPi = await stripe.paymentIntents.create({
              amount: offer.priceCents,
              currency: 'usd',
              capture_method: 'manual',
              customer: stripeCustomerId,
              payment_method: paymentMethodId,
              confirm: true,
              automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
              metadata: piMetadata,
            }, { idempotencyKey: `offer-${offer.id}-authentication` });
            stripePaymentIntentId = onSessionPi.id;
            paymentClientSecret = onSessionPi.client_secret;
            requiresAction = onSessionPi.status === 'requires_action';
          } else {
            throw piErr;
          }
        }
      } catch (err: any) {
        // Re-throw our own AppErrors (e.g., no payment method)
        if (err instanceof AppError) throw err;

        // Map Stripe error to user-friendly message
        let userMessage = 'Payment authorization failed. Please try again.';
        const stripeCode = err.code ?? err.decline_code ?? '';

        if (stripeCode === 'card_declined' || err.decline_code) {
          userMessage = 'Your card was declined. Please update your payment method and try again.';
        } else if (stripeCode === 'insufficient_funds') {
          userMessage = 'Insufficient funds on your card. Please use a different card.';
        } else if (stripeCode === 'expired_card') {
          userMessage = 'Your card has expired. Please update your payment method.';
        } else if (stripeCode === 'incorrect_cvc') {
          userMessage = 'Incorrect CVC. Please check your card details.';
        } else if (stripeCode === 'processing_error') {
          userMessage = 'Payment processing error. Please try again in a moment.';
        }

        console.error('Stripe PaymentIntent creation failed:', err.message);
        throw new AppError(402, ErrorCode.VALIDATION_ERROR, userMessage);
      }
    } else {
      stripePaymentIntentId = `pi_mock_${Date.now()}`;
    }

    // ── 3DS required: return early WITHOUT booking ──
    if (requiresAction) {
      return {
        requiresAction: true as const,
        offerId: offer.id,
        requestId: request.id,
        shopId: offer.shopId,
        shopName: shop?.name ?? 'Shop',
        priceCents: offer.priceCents,
        stripePaymentIntentId: stripePaymentIntentId!,
        paymentClientSecret: paymentClientSecret!,
        publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? '',
      };
    }

    // ── No 3DS: proceed with immediate booking ──
    // 6. Accept the offer
    await tx
      .update(offers)
      .set({ status: 'ACCEPTED', updatedAt: new Date() })
      .where(eq(offers.id, offerId));

    // 7. Expire every competing offer / dispatch now that this shop won.
    const expiredDispatches = await expireCompetingMarketplaceState(
      tx,
      request.id,
      offerId,
      offer.shopId,
    );

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

    // 11. Status event
    await tx.insert(jobStatusEvents).values({
      jobId: job.id,
      fromStatus: null,
      toStatus: 'BOOKED',
      note: `Job created — customer accepted offer. Payment held: $${(offer.priceCents / 100).toFixed(2)}`,
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
      requiresAction: false as const,
      jobId: job.id,
      offerId: offer.id,
      requestId: request.id,
      shopId: offer.shopId,
      shopName: shop?.name ?? 'Shop',
      deviceBrand: request.deviceBrand,
      deviceModel: request.deviceModel,
      priceCents: offer.priceCents,
      platformFeeCents,
      expiredDispatches,
      stripePaymentIntentId,
      status: 'BOOKED' as const,
    };
  });

  // If 3DS is required, return early — no booking events
  if (result.requiresAction) {
    return result;
  }

  // Socket.IO events (only for immediate bookings)
  try {
    const io = getIO();
    await notifyShop({
      shopId: result.shopId,
      event: 'offer:accepted',
      payload: { offerId: result.offerId, requestId: result.requestId, jobId: result.jobId },
      push: { title: 'Offer Accepted!', body: 'A customer accepted your offer.', data: { screen: 'job-details', jobId: result.jobId } },
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
    io.to(`request:${result.requestId}`).emit('request:booked', {
      requestId: result.requestId,
      jobId: result.jobId,
    });
    // Also emit to customer room so list screen updates
    await notifyCustomer({
      customerId,
      event: 'request:booked',
      payload: { requestId: result.requestId, jobId: result.jobId },
      push: { title: 'Request Booked!', body: 'Your repair request has been booked.', data: { screen: 'job-detail', jobId: result.jobId } },
    });
  } catch {}

  if (customerEmail) {
    sendOrderBookingConfirmationEmail(customerEmail, {
      customerName: customerFullName,
      shopName: result.shopName,
      jobId: result.jobId,
      amountCents: result.priceCents,
      deviceLabel: `${result.deviceBrand} ${result.deviceModel}`,
    }).catch((err) => console.error('Failed to send booking confirmation email:', err));
  }

  return result;
}

// ─── Confirm Offer Payment (after 3DS) ───

export async function confirmOfferPayment(
  offerId: string,
  customerId: string,
  stripePaymentIntentId: string,
) {
  // 1. Verify the Stripe PaymentIntent status
  if (!env.STRIPE_SECRET_KEY) {
    throw new AppError(500, ErrorCode.INTERNAL_ERROR, 'Stripe is not configured');
  }

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);

  // Resolve the offer and customer before touching the client-supplied
  // PaymentIntent. This prevents a caller from presenting a valid Stripe
  // PaymentIntent belonging to another customer or another offer.
  const [expectedOffer] = await db
    .select({ requestId: offers.requestId, priceCents: offers.priceCents, shopId: offers.shopId })
    .from(offers)
    .where(eq(offers.id, offerId))
    .limit(1);
  if (!expectedOffer) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Offer not found');
  }

  const [expectedRequest] = await db
    .select({ customerId: requests.customerId })
    .from(requests)
    .where(eq(requests.id, expectedOffer.requestId))
    .limit(1);
  if (!expectedRequest || expectedRequest.customerId !== customerId) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Not your request');
  }

  const expectedStripeCustomerId = await ensureStripeCustomerForUser(stripe, customerId);
  const pi = await stripe.paymentIntents.retrieve(stripePaymentIntentId);

  const paymentIntentCustomerId =
    typeof pi.customer === 'string' ? pi.customer : pi.customer?.id ?? null;
  if (
    paymentIntentCustomerId !== expectedStripeCustomerId ||
    pi.metadata?.offerId !== offerId ||
    pi.metadata?.requestId !== expectedOffer.requestId ||
    (pi.metadata?.customerId && pi.metadata.customerId !== customerId) ||
    pi.metadata?.shopId !== expectedOffer.shopId ||
    pi.amount !== expectedOffer.priceCents ||
    pi.currency !== 'usd' ||
    pi.capture_method !== 'manual'
  ) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Payment verification does not match this offer');
  }

  // If 3DS still pending
  if (pi.status === 'requires_action') {
    return {
      status: 'requires_action' as const,
      clientSecret: pi.client_secret,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? '',
    };
  }

  // If needs server-side confirmation
  if (pi.status === 'requires_confirmation') {
    const confirmed = await stripe.paymentIntents.confirm(pi.id);
    if (confirmed.status === 'requires_action') {
      return {
        status: 'requires_action' as const,
        clientSecret: confirmed.client_secret,
        publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? '',
      };
    }
    if (confirmed.status !== 'requires_capture') {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR,
        'Payment verification failed. Please try again.');
    }
  } else if (pi.status === 'canceled' || pi.last_payment_error) {
    // Payment failed — let customer retry
    const errorMessage = pi.last_payment_error?.message ?? 'Payment failed.';
    throw new AppError(402, ErrorCode.VALIDATION_ERROR,
      `${errorMessage} Please update your card and try again.`);
  } else if (pi.status !== 'requires_capture') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR,
      `Unexpected payment status: ${pi.status}. Please try again.`);
  }

  // 2. PI is verified (requires_capture = authorized). Now complete the booking.
  let customerEmail: string | null = null;
  let customerFullName: string | null = null;

  const result = await db.transaction(async (tx) => {
    // Get the offer (must still be PENDING)
    const [offer] = await tx
      .select()
      .from(offers)
      .where(eq(offers.id, offerId))
      .limit(1);

    if (!offer) throw new AppError(404, ErrorCode.NOT_FOUND, 'Offer not found');
    if (offer.status !== 'PENDING') {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR,
        `Offer is no longer available (${offer.status}). It may have expired while you were verifying payment.`);
    }

    // Get the request & verify ownership
    const [request] = await tx
      .select()
      .from(requests)
      .where(eq(requests.id, offer.requestId))
      .limit(1);

    if (!request) throw new AppError(404, ErrorCode.NOT_FOUND, 'Request not found');
    if (request.customerId !== customerId) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'Not your request');
    }
    if (request.status !== 'LIVE' && request.status !== 'DISPATCHING') {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR,
        `Request is ${request.status}, cannot accept offers`);
    }

    // Get shop name
    const [shop] = await tx
      .select({ name: shops.name })
      .from(shops)
      .where(eq(shops.id, offer.shopId))
      .limit(1);

    // Get customer info for email
    const [customerUser] = await tx
      .select({ email: users.email, fullName: users.fullName })
      .from(users)
      .where(eq(users.id, customerId))
      .limit(1);
    customerEmail = customerUser?.email ?? null;
    customerFullName = customerUser?.fullName ?? null;

    // Calculate platform fee
    const commissionPercent = await getOrderCommissionPercent();
    const platformFeeCents = Math.round(offer.priceCents * (commissionPercent / 100));

    // Accept the offer
    await tx
      .update(offers)
      .set({ status: 'ACCEPTED', updatedAt: new Date() })
      .where(eq(offers.id, offer.id));

    // Expire every competing offer / dispatch now that this shop won.
    const expiredDispatches = await expireCompetingMarketplaceState(
      tx,
      request.id,
      offer.id,
      offer.shopId,
    );
    await tx
      .update(dispatchTargets)
      .set({ status: 'ACCEPTED' })
      .where(
        and(
          eq(dispatchTargets.requestId, request.id),
          eq(dispatchTargets.shopId, offer.shopId),
        ),
      );

    // Mark request as BOOKED
    await tx
      .update(requests)
      .set({ status: 'BOOKED', updatedAt: new Date() })
      .where(eq(requests.id, request.id));

    // Create the job
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

    // Status event
    await tx.insert(jobStatusEvents).values({
      jobId: job.id,
      fromStatus: null,
      toStatus: 'BOOKED',
      note: `Job created — customer accepted offer (3DS verified). Payment held: $${(offer.priceCents / 100).toFixed(2)}`,
    });

    // Auto-adjust inventory
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
      status: 'succeeded' as const,
      jobId: job.id,
      offerId: offer.id,
      requestId: request.id,
      shopId: offer.shopId,
      shopName: shop?.name ?? 'Shop',
      deviceBrand: request.deviceBrand,
      deviceModel: request.deviceModel,
      priceCents: offer.priceCents,
      expiredDispatches,
    };
  });

  // Emit booking events
  try {
    const io = getIO();
    await notifyShop({
      shopId: result.shopId,
      event: 'offer:accepted',
      payload: { offerId: result.offerId, requestId: result.requestId, jobId: result.jobId },
      push: { title: 'Offer Accepted!', body: 'A customer accepted your offer.', data: { screen: 'job-details', jobId: result.jobId } },
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
    io.to(`request:${result.requestId}`).emit('request:booked', {
      requestId: result.requestId,
      jobId: result.jobId,
    });
    await notifyCustomer({
      customerId,
      event: 'request:booked',
      payload: { requestId: result.requestId, jobId: result.jobId },
      push: { title: 'Request Booked!', body: 'Your repair request has been booked.', data: { screen: 'job-detail', jobId: result.jobId } },
    });
  } catch {}

  if (customerEmail) {
    sendOrderBookingConfirmationEmail(customerEmail, {
      customerName: customerFullName,
      shopName: result.shopName,
      jobId: result.jobId,
      amountCents: result.priceCents,
      deviceLabel: `${result.deviceBrand} ${result.deviceModel}`,
    }).catch((err) => console.error('Failed to send booking confirmation email:', err));
  }

  return result;
}

// ─── Reject Offer ───

export async function rejectOffer(offerId: string, customerId: string) {
  const [offer] = await db
    .select()
    .from(offers)
    .where(eq(offers.id, offerId))
    .limit(1);

  if (!offer) throw new AppError(404, ErrorCode.NOT_FOUND, 'Offer not found');
  if (offer.status !== 'PENDING') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, `Offer is already ${offer.status}`);
  }

  // Verify ownership
  const [request] = await db
    .select({ customerId: requests.customerId })
    .from(requests)
    .where(eq(requests.id, offer.requestId))
    .limit(1);

  if (!request || request.customerId !== customerId) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Not your request');
  }

  await db
    .update(offers)
    .set({ status: 'REJECTED', updatedAt: new Date() })
    .where(eq(offers.id, offerId));

  // Release inventory reservation if any
  if (offer.reserveInventoryItemId) {
    await db
      .update(inventoryItems)
      .set({
        quantityReserved: sql`GREATEST(0, ${inventoryItems.quantityReserved} - 1)`,
        updatedAt: new Date(),
      })
      .where(eq(inventoryItems.id, offer.reserveInventoryItemId));
  }

  // Mark the shop's dispatch target as DECLINED so it leaves their live feed
  await db
    .update(dispatchTargets)
    .set({ status: 'DECLINED', expiresAt: new Date() })
    .where(
      and(
        eq(dispatchTargets.requestId, offer.requestId),
        eq(dispatchTargets.shopId, offer.shopId),
        inArray(dispatchTargets.status, ['OFFERED', 'SENT', 'SEEN']),
      ),
    );

  try {
    await notifyShop({
      shopId: offer.shopId,
      event: 'offer:rejected',
      payload: { offerId: offer.id, requestId: offer.requestId },
      push: { title: 'Offer Rejected', body: 'A customer rejected your offer.', data: { screen: 'request-details', requestId: offer.requestId } },
    });
  } catch {}

  // Try dispatching to the next available shop, or expire the request if
  // all shops are exhausted (this also sends "no stores available" to customer)
  const dispatchResult = await dispatchNextShop(offer.requestId);

  return { offerId: offer.id, status: 'REJECTED', dispatch: dispatchResult };
}

// ─── Cancel Request ───

export async function cancelCustomerRequest(requestId: string, customerId: string) {
  const [request] = await db
    .select()
    .from(requests)
    .where(and(eq(requests.id, requestId), eq(requests.customerId, customerId)))
    .limit(1);

  if (!request) throw new AppError(404, ErrorCode.NOT_FOUND, 'Request not found');
  if (request.status === 'BOOKED' || request.status === 'CANCELLED' || request.status === 'EXPIRED') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, `Cannot cancel a ${request.status} request`);
  }

  const affectedDispatches = await db
    .select({ shopId: dispatchTargets.shopId })
    .from(dispatchTargets)
    .where(eq(dispatchTargets.requestId, requestId));

  await db
    .update(requests)
    .set({ status: 'CANCELLED', updatedAt: new Date() })
    .where(eq(requests.id, requestId));

  // Reject all pending offers
  await db
    .update(offers)
    .set({ status: 'REJECTED', updatedAt: new Date() })
    .where(and(eq(offers.requestId, requestId), eq(offers.status, 'PENDING')));

  // Mark pending dispatches as skipped
  await db
    .update(dispatchTargets)
    .set({ status: 'SKIPPED' })
    .where(
      and(
        eq(dispatchTargets.requestId, requestId),
        not(inArray(dispatchTargets.status, ['SKIPPED', 'EXPIRED', 'DECLINED'])),
      ),
    );

  try {
    const io = getIO();
    io.to(`request:${requestId}`).emit('request:cancelled', { requestId });
    const affectedShopIds = [...new Set(affectedDispatches.map((row) => row.shopId).filter(Boolean))];
    for (const shopId of affectedShopIds) {
      io.to(`shop:${shopId}`).emit('request:cancelled', { requestId });
    }
    await notifyCustomer({
      customerId,
      event: 'request:cancelled',
      payload: { requestId },
    });
  } catch {}

  return { requestId, status: 'CANCELLED' };
}

// ─── List Customer Jobs ───

export async function listCustomerJobs(
  customerId: string,
  status: 'ACTIVE' | 'COMPLETED',
  page: number,
  pageSize: number,
) {
  const offset = (page - 1) * pageSize;

  const activeStatuses = ['BOOKED', 'CHECKED_IN', 'IN_PROGRESS', 'READY'];
  const completedStatuses = ['COMPLETED', 'CANCELLED', 'DISPUTED'];

  const statusFilter =
    status === 'ACTIVE'
      ? inArray(jobs.status, activeStatuses as any)
      : inArray(jobs.status, completedStatuses as any);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(jobs)
    .where(and(eq(jobs.customerId, customerId), statusFilter));

  const total = Number(countResult?.count ?? 0);

  const rows = await db
    .select({
      id: jobs.id,
      requestId: jobs.requestId,
      shopId: jobs.shopId,
      shopName: shops.name,
      shopLogoUrl: shops.logoUrl,
      deviceBrand: jobs.deviceBrand,
      deviceModel: jobs.deviceModel,
      issueDescription: jobs.issueDescription,
      priceCents: jobs.priceCents,
      etaMinutes: jobs.etaMinutes,
      warrantyDays: jobs.warrantyDays,
      partsQuality: jobs.partsQuality,
      status: jobs.status,
      paymentStatus: jobs.paymentStatus,
      scheduledAt: jobs.scheduledAt,
      completedAt: jobs.completedAt,
      createdAt: jobs.createdAt,
      updatedAt: jobs.updatedAt,
    })
    .from(jobs)
    .leftJoin(shops, eq(jobs.shopId, shops.id))
    .where(and(eq(jobs.customerId, customerId), statusFilter))
    .orderBy(desc(jobs.createdAt))
    .limit(pageSize)
    .offset(offset);

  return {
    data: rows.map((r) => ({
      ...r,
      scheduledAt: r.scheduledAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      createdAt: r.createdAt?.toISOString() ?? null,
      updatedAt: r.updatedAt?.toISOString() ?? null,
    })),
    total,
  };
}

// ─── Get Customer Job Detail ───

export async function getCustomerJobDetail(jobId: string, customerId: string) {
  const [job] = await db
    .select({
      id: jobs.id,
      requestId: jobs.requestId,
      offerId: jobs.offerId,
      shopId: jobs.shopId,
      shopName: shops.name,
      shopLogoUrl: shops.logoUrl,
      deviceBrand: jobs.deviceBrand,
      deviceModel: jobs.deviceModel,
      issueDescription: jobs.issueDescription,
      priceCents: jobs.priceCents,
      etaMinutes: jobs.etaMinutes,
      warrantyDays: jobs.warrantyDays,
      partsQuality: jobs.partsQuality,
      status: jobs.status,
      paymentStatus: jobs.paymentStatus,
      scheduledAt: jobs.scheduledAt,
      completedAt: jobs.completedAt,
      stripePaymentIntentId: jobs.stripePaymentIntentId,
      platformFeeCents: jobs.platformFeeCents,
      proofMedia: jobs.proofMedia,
      customerInitialVideoUrl: jobs.customerInitialVideoUrl,
      shopCompletionVideoUrl: jobs.shopCompletionVideoUrl,
      paymentError: jobs.paymentError,
      createdAt: jobs.createdAt,
      updatedAt: jobs.updatedAt,
    })
    .from(jobs)
    .leftJoin(shops, eq(jobs.shopId, shops.id))
    .where(and(eq(jobs.id, jobId), eq(jobs.customerId, customerId)))
    .limit(1);

  if (!job) throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');

  const customerInitialVideoUrl =
    job.customerInitialVideoUrl ??
    (
      await db
        .select({ videoUrl: requests.videoUrl })
        .from(requests)
        .where(eq(requests.id, job.requestId))
        .limit(1)
    )[0]?.videoUrl ??
    null;

  const shopCompletionVideoUrl =
    job.shopCompletionVideoUrl ??
    (
      await db
        .select({ url: jobMedia.url })
        .from(jobMedia)
        .where(and(eq(jobMedia.jobId, jobId), eq(jobMedia.type, 'VIDEO')))
        .orderBy(desc(jobMedia.createdAt))
        .limit(1)
    )[0]?.url ??
    null;

  // Get shop average rating from reviews
  const [ratingResult] = await db
    .select({
      avgRating: sql<number>`coalesce(round(avg(${reviews.rating})::numeric, 1), 0)`,
      totalReviews: sql<number>`count(*)`,
    })
    .from(reviews)
    .where(and(eq(reviews.shopId, job.shopId), eq(reviews.isHidden, false)));

  // Check if customer already reviewed this job
  const [existingReview] = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(and(eq(reviews.jobId, jobId), eq(reviews.customerId, customerId)))
    .limit(1);

  // Get status events (timeline)
  const events = await db
    .select()
    .from(jobStatusEvents)
    .where(eq(jobStatusEvents.jobId, jobId))
    .orderBy(jobStatusEvents.createdAt);

  return {
    ...job,
    customerInitialVideoUrl,
    shopCompletionVideoUrl,
    shopRating: Number(ratingResult?.avgRating ?? 0),
    shopReviewCount: Number(ratingResult?.totalReviews ?? 0),
    hasReview: !!existingReview,
    scheduledAt: job.scheduledAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    createdAt: job.createdAt?.toISOString() ?? null,
    updatedAt: job.updatedAt?.toISOString() ?? null,
    timeline: events.map((e) => ({
      id: e.id,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      note: e.note,
      createdAt: e.createdAt?.toISOString() ?? null,
    })),
  };
}

// ─── Confirm Job & Release Payment ───

export async function confirmCustomerJob(
  jobId: string,
  customerId: string,
  rating?: number,
  reviewText?: string,
) {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.customerId, customerId)))
    .limit(1);

  if (!job) throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');
  if (job.status !== 'READY') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, `Cannot confirm a ${job.status} job`);
  }

  // Use fee stored when job was booked (calculated from admin settings at booking time)
  const platformFeeCents =
    typeof job.platformFeeCents === 'number'
      ? job.platformFeeCents
      : Math.round(job.priceCents * ((await getOrderCommissionPercent()) / 100));
  const netAmountCents = job.priceCents - platformFeeCents;

  // ── Transfer funds from platform balance → shop's Stripe Connected Account ──
  let stripeTransferId: string | null = null;

  const [shop] = await db
    .select({ stripeAccountId: shops.stripeAccountId })
    .from(shops)
    .where(eq(shops.id, job.shopId))
    .limit(1);

  const acct = shop?.stripeAccountId;

  if (
    acct &&
    !acct.startsWith('acct_mock_') &&
    env.STRIPE_SECRET_KEY &&
    job.stripePaymentIntentId &&
    !job.stripePaymentIntentId.startsWith('pi_mock_')
  ) {
    try {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(env.STRIPE_SECRET_KEY);

      // Retrieve the charge ID so we can attach source_transaction
      const pi = await stripe.paymentIntents.retrieve(job.stripePaymentIntentId);
      const chargeId =
        typeof pi.latest_charge === 'string'
          ? pi.latest_charge
          : pi.latest_charge?.id;

      const transferParams: any = {
        amount: netAmountCents,
        currency: 'usd',
        destination: acct,
        transfer_group: job.id,
        metadata: { jobId: job.id, shopId: job.shopId, platformFeeCents },
      };
      if (chargeId) {
        transferParams.source_transaction = chargeId;
      }

      const transfer = await stripe.transfers.create(transferParams);
      stripeTransferId = transfer.id;
      console.log(
        `💸 Transfer ${transfer.id} — $${(netAmountCents / 100).toFixed(2)} → ${acct} (fee $${(platformFeeCents / 100).toFixed(2)})`,
      );
    } catch (err: any) {
      console.error('⚠️ Stripe Transfer failed:', err.message);
    }
  }

  // Update job status → COMPLETED, paymentStatus → RELEASED
  await db
    .update(jobs)
    .set({
      status: 'COMPLETED',
      paymentStatus: 'RELEASED',
      platformFeeCents,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));

  // Add status event
  await db.insert(jobStatusEvents).values({
    jobId: job.id,
    fromStatus: 'READY',
    toStatus: 'COMPLETED',
    note: `Customer confirmed repair. $${(netAmountCents / 100).toFixed(2)} transferred to shop (7 % platform fee: $${(platformFeeCents / 100).toFixed(2)}).`,
  });

  // Create payout record for earnings tracking
  await db.insert(payouts).values({
    shopId: job.shopId,
    jobId: job.id,
    amountCents: job.priceCents,
    platformFeeCents,
    netAmountCents,
    stripeTransferId,
    status: 'COMPLETED',
    completedAt: new Date(),
  });

  // Socket.IO
  try {
    const io = getIO();
    await notifyShop({
      shopId: job.shopId,
      event: 'job:payment',
      payload: { jobId: job.id, status: 'RELEASED', priceCents: job.priceCents, platformFeeCents, netAmountCents, stripeTransferId, type: 'customer_confirmed' },
      push: { title: 'Payment Released!', body: `You've received payment for a completed job.`, data: { screen: 'job-details', jobId: job.id } },
      persist: {
        category: 'payout',
        title: 'Payment Released!',
        body: `You've received $${(netAmountCents / 100).toFixed(2)} for a completed job.`,
        data: { screen: 'job-details', jobId: job.id },
      },
    });
    io.to(`job:${job.id}`).emit('job:status', {
      jobId: job.id,
      status: 'COMPLETED',
      paymentStatus: 'RELEASED',
    });
  } catch {}

  return {
    jobId: job.id,
    status: 'COMPLETED',
    paymentStatus: 'RELEASED',
    priceCents: job.priceCents,
    platformFeeCents,
    netAmountCents,
    stripeTransferId,
  };
}

// ─── Update Payment Method (re-authorize after card failure) ───

export async function updateJobPaymentMethod(jobId: string, customerId: string) {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.customerId, customerId)))
    .limit(1);

  if (!job) throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');

  if (job.paymentStatus !== 'PAYMENT_FAILED') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Payment method can only be updated when payment has failed');
  }

  // Cancel the old PaymentIntent if it exists
  if (job.stripePaymentIntentId && !job.stripePaymentIntentId.startsWith('pi_mock_') && env.STRIPE_SECRET_KEY) {
    try {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(env.STRIPE_SECRET_KEY);
      await stripe.paymentIntents.cancel(job.stripePaymentIntentId);
    } catch (err: any) {
      // May already be cancelled, that's fine
      console.log('Old PI cancel:', err.message);
    }
  }

  // Create a fresh PaymentIntent with manual capture
  let newPaymentIntentId: string;

  if (env.STRIPE_SECRET_KEY) {
    try {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(env.STRIPE_SECRET_KEY);

      const stripeCustomerId = await ensureStripeCustomerForUser(stripe, customerId);
      const stripeCustomer = await stripe.customers.retrieve(stripeCustomerId);
      if (stripeCustomer.deleted) {
        throw new AppError(400, ErrorCode.VALIDATION_ERROR,
          'Your payment profile was removed. Please add a new card in Settings → Payment Methods.');
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
        throw new AppError(400, ErrorCode.VALIDATION_ERROR,
          'No payment method on file. Please add a card in Settings → Payment Methods.');
      }

      const pi = await stripe.paymentIntents.create({
        amount: job.priceCents,
        currency: 'usd',
        capture_method: 'manual',
        customer: stripeCustomerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        metadata: {
          jobId: job.id,
          customerId,
          requestId: job.requestId,
          offerId: job.offerId,
          shopId: job.shopId,
          customerName: job.customerName,
          retryPayment: 'true',
        },
      });
      newPaymentIntentId = pi.id;
    } catch (err: any) {
      let userMessage = 'Payment authorization failed. Please try again.';
      const stripeCode = err.code ?? err.decline_code ?? '';
      if (stripeCode === 'card_declined' || err.decline_code) {
        userMessage = 'Your card was declined. Please try a different card.';
      } else if (stripeCode === 'insufficient_funds') {
        userMessage = 'Insufficient funds. Please use a different card.';
      } else if (stripeCode === 'expired_card') {
        userMessage = 'Your card has expired. Please use a different card.';
      }
      throw new AppError(402, ErrorCode.VALIDATION_ERROR, userMessage);
    }
  } else {
    newPaymentIntentId = `pi_mock_${Date.now()}`;
  }

  // Update job with new PaymentIntent, reset payment status to HELD
  await db.update(jobs).set({
    stripePaymentIntentId: newPaymentIntentId,
    paymentStatus: 'HELD',
    paymentError: null,
    updatedAt: new Date(),
  }).where(eq(jobs.id, jobId));

  // Add status event
  await db.insert(jobStatusEvents).values({
    jobId,
    fromStatus: 'IN_PROGRESS',
    toStatus: 'IN_PROGRESS',
    note: 'Customer updated payment method. Card re-authorized successfully.',
  });

  // Notify store that card has been updated
  try {
    const io = getIO();
    await notifyShop({
      shopId: job.shopId,
      event: 'job:card_updated',
      payload: { jobId, message: 'Customer has updated their card. You can now mark this job as ready.' },
      push: { title: 'Card Updated', body: 'Customer updated their payment method. You can now complete the job.', data: { screen: 'job-details', jobId } },
    });
    io.to(`job:${jobId}`).emit('job:payment', { jobId });
  } catch {}

  return {
    jobId: job.id,
    paymentStatus: 'HELD',
    message: 'Card updated successfully. The repair shop can now mark your job as ready.',
  };
}
