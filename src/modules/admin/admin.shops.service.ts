import { eq, and, or, ne, ilike, sql, desc, count, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  shops,
  memberships,
  users,
  jobs,
  payouts,
  onboardingSubmissions,
  inventoryItems,
  inventoryMovements,
} from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';

interface ListShopsQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
}

export async function listShops(query: ListShopsQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (query.status) {
    if (query.status === 'SUSPENDED') {
      conditions.push(eq(shops.vacationMode, true));
    } else {
      conditions.push(eq(shops.onboardingStatus, query.status as any));
    }
  }
  if (query.search) {
    conditions.push(
      or(
        ilike(shops.name, `%${query.search}%`),
        ilike(shops.city, `%${query.search}%`),
        ilike(shops.address, `%${query.search}%`),
      ),
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: shops.id,
        name: shops.name,
        onboardingStatus: shops.onboardingStatus,
        vacationMode: shops.vacationMode,
        phone: shops.phone,
        city: shops.city,
        state: shops.state,
        country: shops.country,
        categories: shops.categories,
        logoUrl: shops.logoUrl,
        address: shops.address,
        latitude: shops.latitude,
        longitude: shops.longitude,
        serviceRadius: shops.serviceRadius,
        stripeConnected: shops.stripeConnected,
        priorityEnabled: shops.priorityEnabled,
        priorityLevel: shops.priorityLevel,
        createdAt: shops.createdAt,
      })
      .from(shops)
      .where(where)
      .orderBy(desc(shops.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(shops).where(where),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

export async function getShopById(shopId: string) {
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId)).limit(1);
  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');

  // Get owner via memberships
  const ownerMembership = await db
    .select({
      userId: memberships.userId,
      role: memberships.role,
      email: users.email,
      fullName: users.fullName,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.shopId, shopId), eq(memberships.role, 'OWNER')))
    .limit(1);

  // Get onboarding submission
  const [submission] = await db
    .select()
    .from(onboardingSubmissions)
    .where(eq(onboardingSubmissions.shopId, shopId))
    .limit(1);

  return {
    ...shop,
    createdAt: shop.createdAt?.toISOString() ?? null,
    updatedAt: shop.updatedAt?.toISOString() ?? null,
    owner: ownerMembership[0] ?? null,
    onboardingSubmission: submission
      ? {
          ...submission,
          submittedAt: submission.submittedAt?.toISOString() ?? null,
          createdAt: submission.createdAt?.toISOString() ?? null,
          updatedAt: submission.updatedAt?.toISOString() ?? null,
        }
      : null,
  };
}

export async function suspendShop(shopId: string) {
  const [shop] = await db.select({ id: shops.id }).from(shops).where(eq(shops.id, shopId)).limit(1);
  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  await db.update(shops).set({ vacationMode: true, updatedAt: new Date() }).where(eq(shops.id, shopId));
  return { message: 'Shop suspended (vacation mode enabled)', shopId };
}

export async function activateShop(shopId: string) {
  const [shop] = await db.select({ id: shops.id }).from(shops).where(eq(shops.id, shopId)).limit(1);
  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  await db.update(shops).set({ vacationMode: false, updatedAt: new Date() }).where(eq(shops.id, shopId));
  return { message: 'Shop activated', shopId };
}

export async function getShopJobs(shopId: string, query: { page?: number; limit?: number }) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(jobs).where(eq(jobs.shopId, shopId)).orderBy(desc(jobs.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(jobs).where(eq(jobs.shopId, shopId)),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? null,
      updatedAt: r.updatedAt?.toISOString() ?? null,
      scheduledAt: r.scheduledAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

export async function updateShop(
  shopId: string,
  data: {
    name?: string;
    phone?: string;
    website?: string;
    description?: string;
    address?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    country?: string;
    categories?: string[];
    serviceRadius?: number;
    vacationMode?: boolean;
    priorityEnabled?: boolean;
    priorityLevel?: number | null;
  },
) {
  const [shop] = await db.select({ id: shops.id }).from(shops).where(eq(shops.id, shopId)).limit(1);
  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');

  const set: Record<string, any> = { updatedAt: new Date() };
  if (data.name !== undefined) set.name = data.name;
  if (data.phone !== undefined) set.phone = data.phone;
  if (data.website !== undefined) set.website = data.website;
  if (data.description !== undefined) set.description = data.description;
  if (data.address !== undefined) set.address = data.address;
  if (data.city !== undefined) set.city = data.city;
  if (data.state !== undefined) set.state = data.state;
  if (data.zipCode !== undefined) set.zipCode = data.zipCode;
  if (data.country !== undefined) set.country = data.country;
  if (data.categories !== undefined) set.categories = data.categories;
  if (data.serviceRadius !== undefined) set.serviceRadius = data.serviceRadius;
  if (data.vacationMode !== undefined) set.vacationMode = data.vacationMode;
  if (data.priorityEnabled !== undefined) set.priorityEnabled = data.priorityEnabled;
  if (data.priorityLevel !== undefined) set.priorityLevel = data.priorityLevel;

  await db.update(shops).set(set).where(eq(shops.id, shopId));

  return getShopById(shopId);
}

// ────────────────────────────────────────────────────────────────
// Priority management
// ────────────────────────────────────────────────────────────────

/**
 * Set priority for a shop.
 * Checks for conflicts: no two shops within overlapping service areas
 * can share the same priority level.
 */
export async function setShopPriority(
  shopId: string,
  priorityEnabled: boolean,
  priorityLevel: number | null,
) {
  const [shop] = await db
    .select({
      id: shops.id,
      name: shops.name,
      latitude: shops.latitude,
      longitude: shops.longitude,
      serviceRadius: shops.serviceRadius,
    })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');

  // If disabling, just clear it
  if (!priorityEnabled) {
    await db
      .update(shops)
      .set({ priorityEnabled: false, priorityLevel: null, updatedAt: new Date() })
      .where(eq(shops.id, shopId));
    return { message: 'Priority disabled', shopId };
  }

  // Validate level
  if (!priorityLevel || priorityLevel < 1 || priorityLevel > 5) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Priority level must be between 1 and 5');
  }

  if (!shop.latitude || !shop.longitude) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Shop has no location set — cannot assign priority');
  }

  const shopLat = parseFloat(shop.latitude);
  const shopLng = parseFloat(shop.longitude);
  // "Overlap radius" = 50 km — shops within 50 km are considered competing
  const OVERLAP_RADIUS_KM = 50;

  // Check for conflict: another shop in the same area with the same priority level
  const conflicts = await db.execute<{
    id: string;
    name: string;
    distance_km: number;
  }>(sql`
    SELECT s.id, s.name,
      (6371 * acos(
        LEAST(1.0, cos(radians(${shopLat})) * cos(radians(CAST(s.latitude AS double precision)))
        * cos(radians(CAST(s.longitude AS double precision)) - radians(${shopLng}))
        + sin(radians(${shopLat})) * sin(radians(CAST(s.latitude AS double precision))))
      )) AS distance_km
    FROM shops s
    WHERE s.id != ${shopId}
      AND s.priority_enabled = true
      AND s.priority_level = ${priorityLevel}
      AND s.latitude IS NOT NULL
      AND s.longitude IS NOT NULL
      AND (6371 * acos(
        LEAST(1.0, cos(radians(${shopLat})) * cos(radians(CAST(s.latitude AS double precision)))
        * cos(radians(CAST(s.longitude AS double precision)) - radians(${shopLng}))
        + sin(radians(${shopLat})) * sin(radians(CAST(s.latitude AS double precision))))
      )) <= ${OVERLAP_RADIUS_KM}
    LIMIT 1
  `);

  const conflictRows: any[] = (conflicts as any).rows ?? conflicts;
  if (conflictRows.length > 0) {
    const c = conflictRows[0];
    throw new AppError(
      409,
      ErrorCode.CONFLICT,
      `"${c.name}" is already set to priority ${priorityLevel} within ${Math.round(c.distance_km)} km. Please select a different priority level.`,
    );
  }

  await db
    .update(shops)
    .set({ priorityEnabled: true, priorityLevel, updatedAt: new Date() })
    .where(eq(shops.id, shopId));

  return { message: `Priority ${priorityLevel} enabled`, shopId, priorityLevel };
}

/**
 * Get all priority shops near a given shop (within 50 km) to show current assignments.
 */
export async function getNearbyPriorities(shopId: string) {
  const [shop] = await db
    .select({ latitude: shops.latitude, longitude: shops.longitude })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  if (!shop.latitude || !shop.longitude) return [];

  const shopLat = parseFloat(shop.latitude);
  const shopLng = parseFloat(shop.longitude);
  const OVERLAP_RADIUS_KM = 50;

  const result = await db.execute<{
    id: string;
    name: string;
    priority_level: number;
    distance_km: number;
  }>(sql`
    SELECT s.id, s.name, s.priority_level,
      (6371 * acos(
        LEAST(1.0, cos(radians(${shopLat})) * cos(radians(CAST(s.latitude AS double precision)))
        * cos(radians(CAST(s.longitude AS double precision)) - radians(${shopLng}))
        + sin(radians(${shopLat})) * sin(radians(CAST(s.latitude AS double precision))))
      )) AS distance_km
    FROM shops s
    WHERE s.priority_enabled = true
      AND s.priority_level IS NOT NULL
      AND s.latitude IS NOT NULL
      AND s.longitude IS NOT NULL
      AND (6371 * acos(
        LEAST(1.0, cos(radians(${shopLat})) * cos(radians(CAST(s.latitude AS double precision)))
        * cos(radians(CAST(s.longitude AS double precision)) - radians(${shopLng}))
        + sin(radians(${shopLat})) * sin(radians(CAST(s.latitude AS double precision))))
      )) <= ${OVERLAP_RADIUS_KM}
    ORDER BY s.priority_level ASC
  `);

  return (result as any).rows ?? result;
}

export async function getShopEarnings(shopId: string) {
  const [result] = await db
    .select({
      totalEarnings: sql<number>`COALESCE(SUM(${payouts.netAmountCents}), 0)`,
      totalPlatformFees: sql<number>`COALESCE(SUM(${payouts.platformFeeCents}), 0)`,
      completedPayouts: sql<number>`COUNT(*) FILTER (WHERE ${payouts.status} = 'COMPLETED')`,
      pendingPayouts: sql<number>`COUNT(*) FILTER (WHERE ${payouts.status} = 'PENDING')`,
    })
    .from(payouts)
    .where(eq(payouts.shopId, shopId));

  return result;
}

export async function deleteShopCompletely(shopId: string) {
  const [shop] = await db.select({ id: shops.id, name: shops.name }).from(shops).where(eq(shops.id, shopId)).limit(1);
  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');

  await db.transaction(async (tx) => {
    // 1. Inventory movements -> items (items.shopId has no FK to shops)
    //    movements FK to items with CASCADE, so delete items first cascades movements
    await tx.delete(inventoryItems).where(eq(inventoryItems.shopId, shopId));

    // 2. Delete the shop — FK cascades handle everything else:
    //    dispatch_targets, offers, jobs (-> job_media, messages, job_status_events),
    //    payouts, disputes (-> dispute_messages), reviews (-> review_media, review_replies, review_reports),
    //    protection_plans (-> protection_subscribers, protection_claims),
    //    memberships, onboarding_submissions
    await tx.delete(shops).where(eq(shops.id, shopId));
  });

  return { message: 'Shop and all associated data deleted', shopId, shopName: shop.name };
}
