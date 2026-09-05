import { eq, and, desc, count, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { reviews, reviewReports, reviewReplies, shops } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';

interface ListReviewsQuery {
  page?: number;
  limit?: number;
  reportedOnly?: boolean;
  hidden?: boolean;
}

export async function listReviews(query: ListReviewsQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (query.reportedOnly) conditions.push(eq(reviews.isReported, true));
  if (query.hidden !== undefined) conditions.push(eq(reviews.isHidden, query.hidden));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: reviews.id,
        shopId: reviews.shopId,
        shopName: shops.name,
        customerId: reviews.customerId,
        customerName: reviews.customerName,
        jobId: reviews.jobId,
        rating: reviews.rating,
        text: reviews.text,
        isHidden: reviews.isHidden,
        isReported: reviews.isReported,
        createdAt: reviews.createdAt,
      })
      .from(reviews)
      .leftJoin(shops, eq(shops.id, reviews.shopId))
      .where(where)
      .orderBy(desc(reviews.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(reviews).where(where),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

export async function getReviewReports(query: { page?: number; limit?: number }) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: reviewReports.id,
        reviewId: reviewReports.reviewId,
        reporterUserId: reviewReports.reporterUserId,
        shopId: reviewReports.shopId,
        shopName: shops.name,
        reason: reviewReports.reason,
        notes: reviewReports.notes,
        reviewRating: reviews.rating,
        reviewText: reviews.text,
        reviewCustomerName: reviews.customerName,
        isHidden: reviews.isHidden,
        createdAt: reviewReports.createdAt,
      })
      .from(reviewReports)
      .leftJoin(reviews, eq(reviews.id, reviewReports.reviewId))
      .leftJoin(shops, eq(shops.id, reviewReports.shopId))
      .orderBy(desc(reviewReports.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(reviewReports),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

export async function hideReview(reviewId: string) {
  const [review] = await db.select({ id: reviews.id }).from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!review) throw new AppError(404, ErrorCode.NOT_FOUND, 'Review not found');
  await db.update(reviews).set({ isHidden: true, updatedAt: new Date() }).where(eq(reviews.id, reviewId));
  return { message: 'Review hidden', reviewId };
}

export async function unhideReview(reviewId: string) {
  const [review] = await db.select({ id: reviews.id }).from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!review) throw new AppError(404, ErrorCode.NOT_FOUND, 'Review not found');
  await db.update(reviews).set({ isHidden: false, updatedAt: new Date() }).where(eq(reviews.id, reviewId));
  return { message: 'Review unhidden', reviewId };
}

export async function deleteReview(reviewId: string) {
  const [review] = await db.select({ id: reviews.id }).from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!review) throw new AppError(404, ErrorCode.NOT_FOUND, 'Review not found');
  await db.delete(reviews).where(eq(reviews.id, reviewId));
  return { message: 'Review deleted', reviewId };
}
