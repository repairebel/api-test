import { describeRepair } from '../pricing/pricing.service.js';
import type { PriceSnapshot } from '../../db/schema/repair-prices.js';
import { eq, and, ne, sql, desc, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  requests,
  dispatchTargets,
  offers,
  shops,
  jobs,
  jobStatusEvents,
  inventoryItems,
  inventoryMovements,
} from '../../db/schema/index.js';
import type { DaySchedule } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { getIO } from '../../lib/socket.js';
import tzLookup from 'tz-lookup';

/**
 * Compute the current weekday name and HH:MM (24h) in a shop's LOCAL timezone,
 * derived from its latitude/longitude. Business hours are stored in the shop's
 * local time, so we must compare against the shop's local clock — NOT the server's
 * UTC clock (Railway runs in UTC). Without this, a shop open 09:00–18:00 local is
 * wrongly treated as closed after 18:00 UTC (e.g. 14:00 EDT), hiding nearby shops.
 *
 * Returns null if the timezone can't be determined; callers should then SKIP the
 * hours filter rather than excluding the shop (better to dispatch than to hide).
 */
function getShopLocalClock(
  latitude: string | number | null | undefined,
  longitude: string | number | null | undefined,
): { todayName: string; nowHHMM: string } | null {
  if (latitude == null || longitude == null) return null;
  const lat = typeof latitude === 'string' ? parseFloat(latitude) : latitude;
  const lng = typeof longitude === 'string' ? parseFloat(longitude) : longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  let tz: string | null;
  try {
    tz = tzLookup(lat, lng);
  } catch {
    return null;
  }
  if (!tz) return null;

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    let hour = get('hour');
    const minute = get('minute');
    const weekday = get('weekday');
    if (!hour || !minute || !weekday) return null;
    if (hour === '24') hour = '00'; // normalize midnight edge case
    return { todayName: weekday, nowHHMM: `${hour}:${minute}` };
  } catch {
    return null;
  }
}
import { notifyShop, notifyCustomer } from '../../lib/notify.js';
import { scheduleDispatchTimeout } from '../../lib/queue.js';

const DISPATCH_TIMEOUT_MS = 5 * 60_000; // 5 minutes per shop
const MAX_ACTIVE_DISPATCHES = 3;
const ACTIVE_DISPATCH_STATUSES = ['SENT', 'SEEN', 'OFFERED'] as const;

type RequestCancellationReason = 'NO_SHOPS' | 'NO_SHOPS_ACCEPTED' | 'EXPIRED';

interface EligibleShop {
  id: string;
  name: string;
  latitude: string;
  longitude: string;
  service_radius: number;
  categories: string[];
  vacation_mode: boolean;
  business_hours: DaySchedule[] | null;
  distance_km: number;
  priority_enabled: boolean;
  priority_level: number | null;
  score?: number;
}

interface DispatchRequestSnapshot {
  id: string;
  customerId: string;
  deviceBrand: string;
  deviceModel: string;
  issueDescription: string;
  customerOfferCents: number;
  minPriceCents: number;
  issueType?: string | null;
  priceSnapshot?: PriceSnapshot | null;
  photos: string[] | null;
  customerName: string;
  status: string;
  expiresAt: Date;
  createdAt: Date | null;
}

interface ActivatedDispatchTarget {
  id: string;
  requestId: string;
  shopId: string;
  distanceKm: number | null;
  expiresAt: Date | null;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function notifyRequestClosed(
  requestId: string,
  customerId: string,
  reason: RequestCancellationReason,
) {
  const reasonConfig: Record<RequestCancellationReason, { title: string; body: string }> = {
    NO_SHOPS: {
      title: 'No Store available nearby',
      body: 'No Store available nearby within your selected distance.',
    },
    NO_SHOPS_ACCEPTED: {
      title: 'No shops accepted your offer',
      body: 'No shops accepted your offer. Try again with a higher offer or a wider search radius.',
    },
    EXPIRED: {
      title: 'Request Expired',
      body: 'Your repair request expired before a shop completed the deal.',
    },
  };

  const message = reasonConfig[reason];

  try {
    const io = getIO();
    io.to(`request:${requestId}`).emit('request:cancelled', { requestId, reason });
    await notifyCustomer({
      customerId,
      event: 'request:cancelled',
      payload: { requestId, reason },
      push: {
        title: message.title,
        body: message.body,
        data: { screen: 'request-detail', requestId },
      },
      persist: {
        category: 'order',
        title: message.title,
        body: message.body,
        data: { screen: 'request-detail', requestId },
      },
    });
  } catch {}
}

async function expireRequest(
  requestId: string,
  reason: RequestCancellationReason,
  customerId?: string,
) {
  const [request] = await db
    .select({
      id: requests.id,
      customerId: requests.customerId,
      status: requests.status,
    })
    .from(requests)
    .where(eq(requests.id, requestId))
    .limit(1);

  if (!request) {
    return { status: 'NOT_FOUND', reason };
  }

  if (request.status === 'BOOKED' || request.status === 'CANCELLED') {
    return { status: request.status, reason };
  }

  if (request.status !== 'EXPIRED') {
    await db
      .update(requests)
      .set({ status: 'EXPIRED', updatedAt: new Date() })
      .where(eq(requests.id, requestId));
  }

  await notifyRequestClosed(requestId, customerId ?? request.customerId, reason);
  return { status: 'EXPIRED', reason };
}

async function notifyDispatchActivated(
  request: DispatchRequestSnapshot,
  dispatch: ActivatedDispatchTarget,
) {
  const dispatchExpiresAt = toDate(dispatch.expiresAt);
  const requestCreatedAt = toDate(request.createdAt);
  const expiresAtIso =
    dispatchExpiresAt?.toISOString() ?? new Date(Date.now() + DISPATCH_TIMEOUT_MS).toISOString();

  try {
    await notifyShop({
      shopId: dispatch.shopId,
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
        distanceKm: dispatch.distanceKm,
        expiresAt: expiresAtIso,
        dispatchExpiresAt: expiresAtIso,
        photos: request.photos ?? [],
        customerName: request.customerName,
        createdAt: requestCreatedAt?.toISOString(),
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
    // not critical
  }

  try {
    await scheduleDispatchTimeout(dispatch.id, request.id, DISPATCH_TIMEOUT_MS);
  } catch (err) {
    console.error('Failed to schedule dispatch timeout:', err);
  }
}

async function claimDispatchSlots(
  requestId: string,
  slots: number,
): Promise<ActivatedDispatchTarget[]> {
  if (slots <= 0) return [];

  const expiresAt = new Date(Date.now() + DISPATCH_TIMEOUT_MS);
  const claimedResult = await db.execute<{
    id: string;
    request_id: string;
    shop_id: string;
    distance_km: number | null;
    expires_at: Date | null;
  }>(sql`
    WITH next_dispatches AS (
      SELECT id
      FROM dispatch_targets
      WHERE request_id = ${requestId}
        AND status = 'PENDING'
      ORDER BY score DESC NULLS LAST, created_at ASC
      LIMIT ${slots}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE dispatch_targets AS dt
    SET status = 'SENT',
        expires_at = ${expiresAt}
    FROM next_dispatches
    WHERE dt.id = next_dispatches.id
    RETURNING dt.id, dt.request_id, dt.shop_id, dt.distance_km, dt.expires_at
  `);

  const rows = (claimedResult as any).rows ?? claimedResult;
  return rows.map((row: any) => ({
    id: row.id,
    requestId: row.request_id,
    shopId: row.shop_id,
    distanceKm:
      typeof row.distance_km === 'number'
        ? row.distance_km
        : row.distance_km != null
          ? Number(row.distance_km)
          : null,
    expiresAt: toDate(row.expires_at),
  }));
}

export async function notifyExpiredDispatches(
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

async function refillDispatchSlots(requestId: string) {
  const [request] = await db
    .select({
      id: requests.id,
      customerId: requests.customerId,
      deviceBrand: requests.deviceBrand,
      deviceModel: requests.deviceModel,
      issueDescription: requests.issueDescription,
      customerOfferCents: requests.customerOfferCents,
      minPriceCents: requests.minPriceCents,
      issueType: requests.issueType,
      priceSnapshot: requests.priceSnapshot,
      photos: requests.photos,
      customerName: requests.customerName,
      status: requests.status,
      expiresAt: requests.expiresAt,
      createdAt: requests.createdAt,
    })
    .from(requests)
    .where(eq(requests.id, requestId))
    .limit(1);

  if (!request) {
    return { status: 'NOT_FOUND', dispatched: 0, nextShop: null };
  }

  if (request.status === 'BOOKED' || request.status === 'CANCELLED' || request.status === 'EXPIRED') {
    return { status: request.status, dispatched: 0, nextShop: null };
  }

  if (request.expiresAt && new Date(request.expiresAt) <= new Date()) {
    return expireRequest(requestId, 'EXPIRED', request.customerId);
  }

  const [activeCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dispatchTargets)
    .where(
      and(
        eq(dispatchTargets.requestId, requestId),
        inArray(dispatchTargets.status, ACTIVE_DISPATCH_STATUSES as any),
      ),
    );

  const activeCount = Number(activeCountRow?.count ?? 0);
  const slotsToFill = Math.max(0, MAX_ACTIVE_DISPATCHES - activeCount);
  const claimedDispatches = await claimDispatchSlots(requestId, slotsToFill);

  if (claimedDispatches.length > 0) {
    await Promise.all(claimedDispatches.map((dispatch) => notifyDispatchActivated(request, dispatch)));
  }

  if (activeCount + claimedDispatches.length > 0) {
    return {
      status: 'DISPATCHING',
      dispatched: claimedDispatches.length,
      nextShop: claimedDispatches[0]?.shopId ?? null,
    };
  }

  const [pendingTargetRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dispatchTargets)
    .where(
      and(
        eq(dispatchTargets.requestId, requestId),
        eq(dispatchTargets.status, 'PENDING'),
      ),
    );

  const [pendingOfferRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(offers)
    .where(
      and(
        eq(offers.requestId, requestId),
        eq(offers.status, 'PENDING'),
      ),
    );

  const pendingTargets = Number(pendingTargetRow?.count ?? 0);
  const pendingOffers = Number(pendingOfferRow?.count ?? 0);

  if (pendingTargets > 0 || pendingOffers > 0) {
    return { status: 'DISPATCHING', dispatched: 0, nextShop: null };
  }

  return expireRequest(requestId, 'NO_SHOPS_ACCEPTED', request.customerId);
}

// ────────────────────────────────────────────────────────────────
// startDispatch — called when a customer request is created.
// Finds eligible shops, scores them, and dispatches to the best.
// ────────────────────────────────────────────────────────────────

export async function startDispatch(
  requestId: string,
  options?: { customerMaxDistanceKm?: number },
) {
  // 1. Load the request
  const [request] = await db
    .select()
    .from(requests)
    .where(eq(requests.id, requestId))
    .limit(1);

  if (!request) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Request not found');
  }

  if (!request.latitude || !request.longitude) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Request has no coordinates');
  }

  // 2. Mark request as DISPATCHING
  await db
    .update(requests)
    .set({ status: 'DISPATCHING', updatedAt: new Date() })
    .where(eq(requests.id, requestId));

  // 3. Find eligible shops using Haversine distance in SQL
  const custLat = parseFloat(request.latitude);
  const custLng = parseFloat(request.longitude);

  const eligibleShopsResult = await db.execute<{
    id: string;
    name: string;
    latitude: string;
    longitude: string;
    service_radius: number;
    categories: string[];
    vacation_mode: boolean;
    business_hours: DaySchedule[] | null;
    distance_km: number;
    priority_enabled: boolean;
    priority_level: number | null;
  }>(sql`
    SELECT
      s.id, s.name, s.latitude, s.longitude, s.service_radius,
      s.categories, s.vacation_mode, s.business_hours,
      s.priority_enabled, s.priority_level,
      (6371 * acos(
        LEAST(1.0, cos(radians(${custLat})) * cos(radians(CAST(s.latitude AS double precision)))
        * cos(radians(CAST(s.longitude AS double precision)) - radians(${custLng}))
        + sin(radians(${custLat})) * sin(radians(CAST(s.latitude AS double precision))))
      )) AS distance_km
    FROM shops s
    WHERE s.onboarding_status = 'APPROVED'
      AND s.vacation_mode = false
      AND s.latitude IS NOT NULL
      AND s.longitude IS NOT NULL
      AND s.service_radius IS NOT NULL
      AND (6371 * acos(
        LEAST(1.0, cos(radians(${custLat})) * cos(radians(CAST(s.latitude AS double precision)))
        * cos(radians(CAST(s.longitude AS double precision)) - radians(${custLng}))
        + sin(radians(${custLat})) * sin(radians(CAST(s.latitude AS double precision))))
      )) <= s.service_radius
    ORDER BY distance_km ASC
    LIMIT 20
  `);

  const eligibleShops: EligibleShop[] = (eligibleShopsResult as any).rows ?? eligibleShopsResult;

  // 4. Filter by business hours + category
  // Business hours are evaluated in EACH shop's local timezone (derived from its
  // lat/lng), not the server's UTC clock — see getShopLocalClock above.
  const requestCategory = request.deviceBrand; // Use device brand as category filter
  const customerMaxDistanceKm = options?.customerMaxDistanceKm;
  const customerRadiusFiltered = typeof customerMaxDistanceKm === 'number'
    ? eligibleShops.filter((shop: EligibleShop) => shop.distance_km <= customerMaxDistanceKm)
    : eligibleShops;

  const filtered = customerRadiusFiltered.filter((shop: EligibleShop) => {
    // Check business hours in the shop's local timezone
    if (shop.business_hours && Array.isArray(shop.business_hours) && shop.business_hours.length > 0) {
      const clock = getShopLocalClock(shop.latitude, shop.longitude);
      if (clock) {
        const todaySchedule = shop.business_hours.find(
          (d: DaySchedule) => d.day === clock.todayName,
        );
        if (todaySchedule && !todaySchedule.isOpen) return false;
        if (todaySchedule && todaySchedule.openTime && todaySchedule.closeTime) {
          if (clock.nowHHMM < todaySchedule.openTime || clock.nowHHMM > todaySchedule.closeTime) return false;
        }
      }
      // If the shop's timezone can't be determined, skip the hours filter rather
      // than excluding the shop (better to dispatch than to wrongly hide it).
    }
    // Check category support — only filter if the shop has explicit brand categories
    // Service-type categories (e.g. "Screen Repair") are ignored for brand matching
    if (shop.categories && Array.isArray(shop.categories) && shop.categories.length > 0) {
      const KNOWN_BRANDS = ['apple','samsung','google','motorola','oneplus','lg','sony',
        'huawei','xiaomi','oppo','vivo','nokia','asus','lenovo','htc','blackberry',
        'realme','honor','nothing','pixel','zte','tcl'];
      const brandCats = shop.categories
        .map((c: string) => c.toLowerCase())
        .filter((c: string) => KNOWN_BRANDS.includes(c));
      // Only filter by brand if the shop has at least one brand category
      if (brandCats.length > 0 && !brandCats.includes(requestCategory.toLowerCase()) && !brandCats.includes('all')) {
        return false;
      }
    }
    return true;
  });

  if (filtered.length === 0) {
    await expireRequest(requestId, 'NO_SHOPS', request.customerId);
    return { status: 'NO_SHOPS', dispatched: 0 };
  }

  // 5. Score each shop (priority-weighted dispatch)
  //
  // Priority weight table (probability of being dispatched first):
  //   Level 1 → 80%  |  Level 2 → 60%  |  Level 3 → 40%
  //   Level 4 → 20%  |  Level 5 → 10%  |  No priority → baseline
  //
  // We use a weighted random approach: priority shops get a large score
  // bonus that is then multiplied by a random factor. This means a
  // priority-1 shop will win ~80% of the time, but sometimes a closer
  // non-priority shop still gets the order, keeping things fair.
  const PRIORITY_WEIGHTS: Record<number, number> = { 1: 800, 2: 600, 3: 400, 4: 200, 5: 100 };

  const scored = filtered.map((shop: EligibleShop) => {
    const maxDist = Math.max(...filtered.map((s: EligibleShop) => s.distance_km), 1);
    const distanceScore = Math.round((1 - shop.distance_km / maxDist) * 40); // 0-40
    const fairnessScore = Math.round(Math.random() * 30); // 0-30
    const speedScore = Math.round(Math.random() * 20); // 0-20
    const responseScore = 10; // base score

    let priorityBonus = 0;
    if (shop.priority_enabled && shop.priority_level && PRIORITY_WEIGHTS[shop.priority_level]) {
      // Multiply the weight by a random factor (0.5–1.0) so it's probabilistic
      priorityBonus = Math.round(PRIORITY_WEIGHTS[shop.priority_level] * (0.5 + Math.random() * 0.5));
    }

    const total = distanceScore + fairnessScore + speedScore + responseScore + priorityBonus;
    return { ...shop, score: total };
  });

  // Sort by score descending
  scored.sort((a: EligibleShop, b: EligibleShop) => (b.score ?? 0) - (a.score ?? 0));

  // 6. Insert ALL dispatch_targets (ranked) — mark all PENDING except first which is SENT
  const dispatchRows = scored.map((shop: EligibleShop) => ({
    requestId,
    shopId: shop.id,
    distanceKm: Math.round(shop.distance_km),
    status: 'PENDING' as const,
    score: shop.score,
  }));

  if (dispatchRows.length > 0) {
    await db.insert(dispatchTargets).values(dispatchRows).onConflictDoNothing();
  }

  const dispatchResult = await refillDispatchSlots(requestId);
  return {
    ...dispatchResult,
    firstShop: scored[0]?.id ?? null,
    eligible: scored.length,
  };
}

// ────────────────────────────────────────────────────────────────
// dispatchNextShop — called on timeout or decline
// ────────────────────────────────────────────────────────────────

export async function dispatchNextShop(requestId: string) {
  return refillDispatchSlots(requestId);
}

// ────────────────────────────────────────────────────────────────
// timeoutDispatch — called by BullMQ worker when 30s elapses
// ────────────────────────────────────────────────────────────────

export async function timeoutDispatch(dispatchId: string, requestId: string) {
  // Only timeout if the shop never completed the dispatch flow.
  const [dispatch] = await db
    .select()
    .from(dispatchTargets)
    .where(
      and(
        eq(dispatchTargets.id, dispatchId),
        inArray(dispatchTargets.status, ['SENT', 'SEEN'] as any),
      ),
    )
    .limit(1);

  if (!dispatch) return; // Already accepted/declined

  // Mark as EXPIRED
  await db
    .update(dispatchTargets)
    .set({ status: 'EXPIRED', expiresAt: new Date() })
    .where(eq(dispatchTargets.id, dispatchId));

  // Emit to shop that dispatch timed out
  try {
    await notifyShop({
      shopId: dispatch.shopId,
      event: 'dispatch:result',
      payload: { dispatchId, requestId, status: 'EXPIRED', message: 'Dispatch timed out' },
    });
    await notifyShop({
      shopId: dispatch.shopId,
      event: 'dispatch:expired',
      payload: {
        dispatchId,
        requestId,
        status: 'EXPIRED',
        message: 'This request moved to another nearby store after the 5 minute timer ended.',
      },
    });
  } catch {}

  // Try next shop
  await dispatchNextShop(requestId);
}

// ────────────────────────────────────────────────────────────────
// acceptDispatch — POST /v1/dispatch/:dispatchId/accept
// Atomic: SELECT FOR UPDATE, create job, expire other stores
// ────────────────────────────────────────────────────────────────

export async function acceptDispatch(dispatchId: string, shopId: string) {
  // Use a transaction with row-level locking
  return await db.transaction(async (tx) => {
    // 1. Lock the dispatch row and verify
    const dispatchResult = await tx.execute<{
      id: string;
      request_id: string;
      shop_id: string;
      status: string;
      expires_at: Date | null;
    }>(
      sql`SELECT id, request_id, shop_id, status, expires_at
          FROM dispatch_targets
          WHERE id = ${dispatchId} AND shop_id = ${shopId}
          FOR UPDATE`,
    );

    const dispatch = ((dispatchResult as any).rows ?? dispatchResult)[0];

    if (!dispatch) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Dispatch not found');
    }

    if (dispatch.status !== 'SENT' && dispatch.status !== 'OFFERED') {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR, `Dispatch is ${dispatch.status}, cannot accept`);
    }

    if (dispatch.expires_at && new Date(dispatch.expires_at) <= new Date()) {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Dispatch has expired');
    }

    // 2. Lock the request and verify it's still DISPATCHING
    const requestResult = await tx.execute<{
      id: string;
      status: string;
      customer_id: string;
      customer_name: string;
      device_brand: string;
      device_model: string;
      issue_description: string;
      video_url: string | null;
      customer_offer_cents: number;
    }>(
      sql`SELECT id, status, customer_id, customer_name, device_brand, device_model, issue_description, video_url, customer_offer_cents
          FROM requests
          WHERE id = ${dispatch.request_id}
          FOR UPDATE`,
    );

    const request = ((requestResult as any).rows ?? requestResult)[0];

    if (!request || (request.status !== 'DISPATCHING' && request.status !== 'LIVE')) {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Request is no longer available');
    }

    // 3. Check if there's an existing offer from this shop (from the offers flow)
    const [existingOffer] = await tx
      .select()
      .from(offers)
      .where(
        and(
          eq(offers.requestId, dispatch.request_id),
          eq(offers.shopId, shopId),
          inArray(offers.status, ['PENDING', 'ACCEPTED']),
        ),
      )
      .limit(1);

    let offerId: string;
    let priceCents: number;
    let etaMinutes: number;
    let warrantyDays: number;
    let partsQuality: string;

    if (existingOffer) {
      // Accept the existing offer
      offerId = existingOffer.id;
      priceCents = existingOffer.priceCents;
      etaMinutes = existingOffer.etaMinutes;
      warrantyDays = existingOffer.warrantyDays;
      partsQuality = existingOffer.partsQuality;

      await tx
        .update(offers)
        .set({ status: 'ACCEPTED', updatedAt: new Date() })
        .where(eq(offers.id, existingOffer.id));
    } else {
      // Create an auto-offer at the customer's offer price
      const [newOffer] = await tx
        .insert(offers)
        .values({
          requestId: dispatch.request_id,
          shopId,
          priceCents: request.customer_offer_cents,
          etaMinutes: 60,
          warrantyDays: 30,
          partsQuality: 'PREMIUM',
          status: 'ACCEPTED',
        })
        .returning();
      offerId = newOffer.id;
      priceCents = newOffer.priceCents;
      etaMinutes = newOffer.etaMinutes;
      warrantyDays = newOffer.warrantyDays;
      partsQuality = newOffer.partsQuality;
    }

    await tx
      .update(offers)
      .set({ status: 'EXPIRED', updatedAt: new Date() })
      .where(
        and(
          eq(offers.requestId, dispatch.request_id),
          ne(offers.shopId, shopId),
          eq(offers.status, 'PENDING'),
        ),
      );

    // 4. Mark dispatch ACCEPTED
    await tx
      .update(dispatchTargets)
      .set({ status: 'ACCEPTED' })
      .where(eq(dispatchTargets.id, dispatchId));

    // 5. Expire all other active dispatches because another shop already won.
    const expiredDispatches = await tx
      .update(dispatchTargets)
      .set({ status: 'EXPIRED', expiresAt: new Date() })
      .where(
        and(
          eq(dispatchTargets.requestId, dispatch.request_id),
          ne(dispatchTargets.id, dispatchId),
          inArray(dispatchTargets.status, ACTIVE_DISPATCH_STATUSES as any),
        ),
      )
      .returning({
        id: dispatchTargets.id,
        shopId: dispatchTargets.shopId,
      });

    // 6. Mark request as BOOKED
    await tx
      .update(requests)
      .set({ status: 'BOOKED', updatedAt: new Date() })
      .where(eq(requests.id, dispatch.request_id));

    // 7. Create the job
    const [job] = await tx
      .insert(jobs)
      .values({
        requestId: dispatch.request_id,
        offerId,
        shopId,
        customerId: request.customer_id,
        customerName: request.customer_name,
        deviceBrand: request.device_brand,
        deviceModel: request.device_model,
        issueDescription: request.issue_description,
        priceCents,
        etaMinutes,
        warrantyDays,
        partsQuality,
        customerInitialVideoUrl: request.video_url ?? null,
        status: 'BOOKED',
        paymentStatus: 'HELD',
      })
      .returning();

    // 8. Create initial status event
    await tx.insert(jobStatusEvents).values({
      jobId: job.id,
      fromStatus: null,
      toStatus: 'BOOKED',
      note: 'Job created from accepted dispatch',
    });

    // 9. Auto-adjust inventory: convert reservation to USED
    if (existingOffer?.reserveInventoryItemId) {
      await tx
        .update(inventoryItems)
        .set({
          quantityReserved: sql`GREATEST(0, ${inventoryItems.quantityReserved} - 1)`,
          quantity: sql`GREATEST(0, ${inventoryItems.quantity} - 1)`,
          updatedAt: new Date(),
        })
        .where(eq(inventoryItems.id, existingOffer.reserveInventoryItemId));

      await tx.insert(inventoryMovements).values({
        inventoryItemId: existingOffer.reserveInventoryItemId,
        type: 'USED',
        quantity: -1,
        referenceId: job.id,
        note: `Used for job – ${request.device_brand} ${request.device_model}`,
      });
    }

    return {
      jobId: job.id,
      requestId: dispatch.request_id,
      customerId: request.customer_id,
      expiredDispatches,
      status: 'ACCEPTED',
    };
  }).then(async (result) => {
    // Emit events outside the transaction
    try {
      const io = getIO();
      await notifyShop({
        shopId,
        event: 'dispatch:result',
        payload: { dispatchId, requestId: result.requestId, status: 'ACCEPTED', jobId: result.jobId },
      });
      await notifyShop({
        shopId,
        event: 'job:created',
        payload: { jobId: result.jobId, requestId: result.requestId },
      });
      io.to(`request:${result.requestId}`).emit('dispatch:accepted', {
        requestId: result.requestId,
        shopId,
        jobId: result.jobId,
      });
      await notifyExpiredDispatches(
        result.expiredDispatches,
        result.requestId,
        'This request is no longer available because the customer accepted another shop.',
      );
      // Notify customer that their request has been booked
      await notifyCustomer({
        customerId: result.customerId,
        event: 'request:booked',
        payload: { requestId: result.requestId, jobId: result.jobId },
        push: { title: 'Request Booked!', body: 'A shop has accepted your repair request.', data: { screen: 'job-detail', jobId: result.jobId } },
        persist: {
          category: 'order',
          title: 'Request Booked!',
          body: 'A shop has accepted your repair request.',
          data: { screen: 'job-detail', jobId: result.jobId },
        },
      });
    } catch {}
    return result;
  });
}

// ────────────────────────────────────────────────────────────────
// declineDispatch — POST /v1/dispatch/:dispatchId/decline
// ────────────────────────────────────────────────────────────────

export async function declineDispatch(dispatchId: string, shopId: string) {
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
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Dispatch not found');
  }

  // If already DECLINED, EXPIRED, ACCEPTED, or SKIPPED — just return success silently
  if (dispatch.status !== 'SENT' && dispatch.status !== 'SEEN') {
    return { dispatchId, status: dispatch.status, next: null };
  }

  // Mark as DECLINED
  await db
    .update(dispatchTargets)
    .set({ status: 'DECLINED', expiresAt: new Date() })
    .where(eq(dispatchTargets.id, dispatchId));

  // Emit result to shop
  try {
    await notifyShop({
      shopId,
      event: 'dispatch:result',
      payload: { dispatchId, requestId: dispatch.requestId, status: 'DECLINED' },
    });
  } catch {}

  // Dispatch to next shop
  const nextResult = await dispatchNextShop(dispatch.requestId);
  return { dispatchId, status: 'DECLINED', next: nextResult };
}
