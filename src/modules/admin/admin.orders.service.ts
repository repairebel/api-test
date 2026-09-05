import { eq, and, or, ilike, sql, desc, count } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { jobs, shops, offers, requests } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';

interface ListOrdersQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
  paymentStatus?: string;
}

export async function listOrders(query: ListOrdersQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (query.status) conditions.push(eq(jobs.status, query.status as any));
  if (query.paymentStatus) conditions.push(eq(jobs.paymentStatus, query.paymentStatus as any));
  if (query.search) {
    conditions.push(
      or(
        ilike(jobs.customerName, `%${query.search}%`),
        ilike(jobs.deviceBrand, `%${query.search}%`),
        ilike(jobs.deviceModel, `%${query.search}%`),
      ),
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: jobs.id,
        requestId: jobs.requestId,
        offerId: jobs.offerId,
        shopId: jobs.shopId,
        shopName: shops.name,
        customerId: jobs.customerId,
        customerName: jobs.customerName,
        deviceBrand: jobs.deviceBrand,
        deviceModel: jobs.deviceModel,
        issueDescription: jobs.issueDescription,
        priceCents: jobs.priceCents,
        platformFeeCents: jobs.platformFeeCents,
        status: jobs.status,
        paymentStatus: jobs.paymentStatus,
        scheduledAt: jobs.scheduledAt,
        completedAt: jobs.completedAt,
        createdAt: jobs.createdAt,
      })
      .from(jobs)
      .leftJoin(shops, eq(shops.id, jobs.shopId))
      .where(where)
      .orderBy(desc(jobs.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(jobs).where(where),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      scheduledAt: r.scheduledAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

export async function getOrderById(orderId: string) {
  const [job] = await db
    .select({
      id: jobs.id,
      requestId: jobs.requestId,
      offerId: jobs.offerId,
      shopId: jobs.shopId,
      shopName: shops.name,
      customerId: jobs.customerId,
      customerName: jobs.customerName,
      deviceBrand: jobs.deviceBrand,
      deviceModel: jobs.deviceModel,
      issueDescription: jobs.issueDescription,
      priceCents: jobs.priceCents,
      etaMinutes: jobs.etaMinutes,
      warrantyDays: jobs.warrantyDays,
      partsQuality: jobs.partsQuality,
      status: jobs.status,
      paymentStatus: jobs.paymentStatus,
      platformFeeCents: jobs.platformFeeCents,
      stripePaymentIntentId: jobs.stripePaymentIntentId,
      proofMedia: jobs.proofMedia,
      disputeReason: jobs.disputeReason,
      paymentError: jobs.paymentError,
      scheduledAt: jobs.scheduledAt,
      completedAt: jobs.completedAt,
      createdAt: jobs.createdAt,
      updatedAt: jobs.updatedAt,
    })
    .from(jobs)
    .leftJoin(shops, eq(shops.id, jobs.shopId))
    .where(eq(jobs.id, orderId))
    .limit(1);

  if (!job) throw new AppError(404, ErrorCode.NOT_FOUND, 'Order not found');

  return {
    ...job,
    scheduledAt: job.scheduledAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    createdAt: job.createdAt?.toISOString() ?? null,
    updatedAt: job.updatedAt?.toISOString() ?? null,
  };
}

export async function getOrderPayment(orderId: string) {
  const [job] = await db
    .select({
      id: jobs.id,
      priceCents: jobs.priceCents,
      platformFeeCents: jobs.platformFeeCents,
      paymentStatus: jobs.paymentStatus,
      stripePaymentIntentId: jobs.stripePaymentIntentId,
      paymentError: jobs.paymentError,
    })
    .from(jobs)
    .where(eq(jobs.id, orderId))
    .limit(1);

  if (!job) throw new AppError(404, ErrorCode.NOT_FOUND, 'Order not found');

  return {
    ...job,
    netAmountCents: job.priceCents - job.platformFeeCents,
  };
}

export async function refundOrder(orderId: string) {
  const [job] = await db
    .select({ id: jobs.id, paymentStatus: jobs.paymentStatus })
    .from(jobs)
    .where(eq(jobs.id, orderId))
    .limit(1);

  if (!job) throw new AppError(404, ErrorCode.NOT_FOUND, 'Order not found');
  if (job.paymentStatus === 'REFUNDED') throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Already refunded');

  await db
    .update(jobs)
    .set({ paymentStatus: 'REFUNDED', updatedAt: new Date() })
    .where(eq(jobs.id, orderId));

  return { message: 'Order refunded', orderId };
}
