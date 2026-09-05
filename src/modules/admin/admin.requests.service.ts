import { eq, and, or, ilike, sql, desc, count } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  requests,
  dispatchTargets,
  offers,
  shops,
} from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';

interface ListRequestsQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
}

export async function listRequests(query: ListRequestsQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (query.status) conditions.push(eq(requests.status, query.status as any));
  if (query.search) {
    conditions.push(
      or(
        ilike(requests.customerName, `%${query.search}%`),
        ilike(requests.deviceBrand, `%${query.search}%`),
        ilike(requests.deviceModel, `%${query.search}%`),
        ilike(requests.issueType, `%${query.search}%`),
      ),
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: requests.id,
      customerId: requests.customerId,
      customerName: requests.customerName,
      deviceBrand: requests.deviceBrand,
      deviceModel: requests.deviceModel,
      issueType: requests.issueType,
      issueDescription: requests.issueDescription,
      photos: requests.photos,
      videoUrl: requests.videoUrl,
      customerOfferCents: requests.customerOfferCents,
      minPriceCents: requests.minPriceCents,
      latitude: requests.latitude,
      longitude: requests.longitude,
      address: requests.address,
      status: requests.status,
      expiresAt: requests.expiresAt,
      createdAt: requests.createdAt,
      updatedAt: requests.updatedAt,
      offersCount: sql<number>`(SELECT count(*)::int FROM offers WHERE offers.request_id = ${requests.id})`.as('offers_count'),
    }).from(requests).where(where).orderBy(desc(requests.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(requests).where(where),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? null,
      updatedAt: r.updatedAt?.toISOString() ?? null,
      expiresAt: r.expiresAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

export async function getRequestById(requestId: string) {
  const [request] = await db.select().from(requests).where(eq(requests.id, requestId)).limit(1);
  if (!request) throw new AppError(404, ErrorCode.NOT_FOUND, 'Request not found');

  return {
    ...request,
    createdAt: request.createdAt?.toISOString() ?? null,
    updatedAt: request.updatedAt?.toISOString() ?? null,
    expiresAt: request.expiresAt?.toISOString() ?? null,
  };
}

export async function getRequestDispatch(requestId: string) {
  const rows = await db
    .select({
      id: dispatchTargets.id,
      requestId: dispatchTargets.requestId,
      shopId: dispatchTargets.shopId,
      shopName: shops.name,
      distanceKm: dispatchTargets.distanceKm,
      status: dispatchTargets.status,
      score: dispatchTargets.score,
      seenAt: dispatchTargets.seenAt,
      expiresAt: dispatchTargets.expiresAt,
      createdAt: dispatchTargets.createdAt,
    })
    .from(dispatchTargets)
    .leftJoin(shops, eq(shops.id, dispatchTargets.shopId))
    .where(eq(dispatchTargets.requestId, requestId))
    .orderBy(desc(dispatchTargets.createdAt));

  return rows.map((r) => ({
    ...r,
    seenAt: r.seenAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt?.toISOString() ?? null,
  }));
}

export async function getRequestOffers(requestId: string) {
  const rows = await db
    .select({
      id: offers.id,
      requestId: offers.requestId,
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
    .leftJoin(shops, eq(shops.id, offers.shopId))
    .where(eq(offers.requestId, requestId))
    .orderBy(desc(offers.createdAt));

  return rows.map((r) => ({
    ...r,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt?.toISOString() ?? null,
  }));
}

export async function cancelRequest(requestId: string) {
  const [request] = await db.select({ id: requests.id, status: requests.status }).from(requests).where(eq(requests.id, requestId)).limit(1);
  if (!request) throw new AppError(404, ErrorCode.NOT_FOUND, 'Request not found');
  if (request.status === 'CANCELLED') throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Request already cancelled');

  await db.update(requests).set({ status: 'CANCELLED', updatedAt: new Date() }).where(eq(requests.id, requestId));
  return { message: 'Request cancelled', requestId };
}
