import { eq, and, or, ilike, sql, desc, count } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { jobs, jobStatusEvents, jobMedia, shops } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';

interface ListJobsQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
}

export async function listJobs(query: ListJobsQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (query.status) conditions.push(eq(jobs.status, query.status as any));
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
        disputeReason: jobs.disputeReason,
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

export async function getJobById(jobId: string) {
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
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!job) throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');

  return {
    ...job,
    scheduledAt: job.scheduledAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    createdAt: job.createdAt?.toISOString() ?? null,
    updatedAt: job.updatedAt?.toISOString() ?? null,
  };
}

export async function getJobEvents(jobId: string) {
  const rows = await db
    .select()
    .from(jobStatusEvents)
    .where(eq(jobStatusEvents.jobId, jobId))
    .orderBy(desc(jobStatusEvents.createdAt));

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt?.toISOString() ?? null,
  }));
}

export async function getJobMedia(jobId: string) {
  const rows = await db
    .select()
    .from(jobMedia)
    .where(eq(jobMedia.jobId, jobId))
    .orderBy(desc(jobMedia.createdAt));

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt?.toISOString() ?? null,
  }));
}

export async function cancelJob(jobId: string) {
  const [job] = await db.select({ id: jobs.id, status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');
  if (job.status === 'CANCELLED') throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Job already cancelled');
  if (job.status === 'COMPLETED') throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Cannot cancel a completed job');

  await db.update(jobs).set({ status: 'CANCELLED', updatedAt: new Date() }).where(eq(jobs.id, jobId));

  // Record status event
  await db.insert(jobStatusEvents).values({
    jobId,
    fromStatus: job.status,
    toStatus: 'CANCELLED',
    note: 'Cancelled by admin',
  });

  return { message: 'Job cancelled', jobId };
}
