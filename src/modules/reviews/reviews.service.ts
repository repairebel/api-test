import { eq, and, desc, lt, sql, ilike, or, asc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  reviews,
  reviewMedia,
  reviewReplies,
  reviewReports,
} from '../../db/schema/index.js';
import { jobs, shops } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { getIO } from '../../lib/socket.js';
import { notifyShop } from '../../lib/notify.js';

// ─── Helpers ───

/** Mask customer name: "Sarah Johnson" → "Sa***n" */
function maskName(name: string): string {
  if (!name || name.length <= 2) return '***';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    const n = parts[0];
    return n.slice(0, 2) + '***' + (n.length > 3 ? n.slice(-1) : '');
  }
  const first = parts[0];
  const last = parts[parts.length - 1];
  return first.slice(0, 2) + '***' + last.slice(-1);
}

// ─── Get review summary ───

export async function getReviewSummary(shopId: string, rangeDays?: number) {
  // Total + avg for all non-hidden reviews
  const [overall] = await db
    .select({
      avgRating: sql<number>`COALESCE(ROUND(AVG(${reviews.rating})::numeric, 2), 0)`,
      totalReviews: sql<number>`COUNT(*)::int`,
    })
    .from(reviews)
    .where(and(eq(reviews.shopId, shopId), eq(reviews.isHidden, false)));

  // Rating breakdown (1-5)
  const breakdownRows = await db
    .select({
      rating: reviews.rating,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(reviews)
    .where(and(eq(reviews.shopId, shopId), eq(reviews.isHidden, false)))
    .groupBy(reviews.rating)
    .orderBy(asc(reviews.rating));

  const ratingBreakdown: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of breakdownRows) {
    ratingBreakdown[row.rating] = row.count;
  }

  // Optional: avg for last N days
  let avgRatingPeriod: number | null = null;
  if (rangeDays && rangeDays > 0) {
    const [periodRow] = await db
      .select({
        avgRating: sql<number>`COALESCE(ROUND(AVG(${reviews.rating})::numeric, 2), 0)`,
      })
      .from(reviews)
      .where(
        and(
          eq(reviews.shopId, shopId),
          eq(reviews.isHidden, false),
          sql`${reviews.createdAt} >= NOW() - INTERVAL '${sql.raw(String(rangeDays))} days'`,
        ),
      );
    avgRatingPeriod = periodRow?.avgRating ?? null;
  }

  return {
    avgRating: Number(overall.avgRating),
    totalReviews: overall.totalReviews,
    ratingBreakdown,
    ...(rangeDays ? { [`avgRatingLast${rangeDays}d`]: avgRatingPeriod ? Number(avgRatingPeriod) : null } : {}),
  };
}

// ─── List reviews (cursor pagination) ───

interface ListReviewsOpts {
  shopId: string;
  rating?: number;
  withText?: boolean;
  sort?: 'newest' | 'oldest' | 'highest' | 'lowest';
  limit: number;
  cursor?: string; // "createdAt|id"
}

export async function listReviews(opts: ListReviewsOpts) {
  const { shopId, rating, withText, sort = 'newest', limit, cursor } = opts;

  const conditions: any[] = [
    eq(reviews.shopId, shopId),
    eq(reviews.isHidden, false),
  ];

  if (rating !== undefined) {
    conditions.push(eq(reviews.rating, rating));
  }
  if (withText) {
    conditions.push(sql`${reviews.text} IS NOT NULL AND ${reviews.text} != ''`);
  }

  // Cursor: "ISO_DATE|UUID"
  if (cursor) {
    const [cursorDate, cursorId] = cursor.split('|');
    if (cursorDate && cursorId) {
      if (sort === 'newest' || sort === 'highest') {
        conditions.push(
          or(
            sql`${reviews.createdAt} < ${cursorDate}::timestamptz`,
            and(
              sql`${reviews.createdAt} = ${cursorDate}::timestamptz`,
              sql`${reviews.id} < ${cursorId}::uuid`,
            ),
          ),
        );
      } else {
        conditions.push(
          or(
            sql`${reviews.createdAt} > ${cursorDate}::timestamptz`,
            and(
              sql`${reviews.createdAt} = ${cursorDate}::timestamptz`,
              sql`${reviews.id} > ${cursorId}::uuid`,
            ),
          ),
        );
      }
    }
  }

  let orderExpr;
  switch (sort) {
    case 'oldest':
      orderExpr = [asc(reviews.createdAt), asc(reviews.id)];
      break;
    case 'highest':
      orderExpr = [desc(reviews.rating), desc(reviews.createdAt), desc(reviews.id)];
      break;
    case 'lowest':
      orderExpr = [asc(reviews.rating), desc(reviews.createdAt), desc(reviews.id)];
      break;
    case 'newest':
    default:
      orderExpr = [desc(reviews.createdAt), desc(reviews.id)];
      break;
  }

  const rows = await db
    .select({
      id: reviews.id,
      customerId: reviews.customerId,
      customerName: reviews.customerName,
      jobId: reviews.jobId,
      rating: reviews.rating,
      text: reviews.text,
      isReported: reviews.isReported,
      createdAt: reviews.createdAt,
    })
    .from(reviews)
    .where(and(...conditions))
    .orderBy(...orderExpr)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;

  // Gather review IDs for batch loading replies + media
  const reviewIds = data.map((r) => r.id);

  // Load replies
  const repliesMap = new Map<string, typeof reviewReplies.$inferSelect>();
  if (reviewIds.length > 0) {
    const replyRows = await db
      .select()
      .from(reviewReplies)
      .where(sql`${reviewReplies.reviewId} IN (${sql.join(reviewIds.map(id => sql`${id}::uuid`), sql`, `)})`);
    for (const r of replyRows) {
      repliesMap.set(r.reviewId, r);
    }
  }

  // Load media
  const mediaMap = new Map<string, Array<typeof reviewMedia.$inferSelect>>();
  if (reviewIds.length > 0) {
    const mediaRows = await db
      .select()
      .from(reviewMedia)
      .where(sql`${reviewMedia.reviewId} IN (${sql.join(reviewIds.map(id => sql`${id}::uuid`), sql`, `)})`);
    for (const m of mediaRows) {
      const arr = mediaMap.get(m.reviewId) ?? [];
      arr.push(m);
      mediaMap.set(m.reviewId, arr);
    }
  }

  // Load job summaries
  const jobIds = data.filter((r) => r.jobId).map((r) => r.jobId!);
  const jobMap = new Map<string, { deviceBrand: string; deviceModel: string; issueDescription: string }>();
  if (jobIds.length > 0) {
    const jobRows = await db
      .select({
        id: jobs.id,
        deviceBrand: jobs.deviceBrand,
        deviceModel: jobs.deviceModel,
        issueDescription: jobs.issueDescription,
      })
      .from(jobs)
      .where(sql`${jobs.id} IN (${sql.join(jobIds.map(id => sql`${id}::uuid`), sql`, `)})`);
    for (const j of jobRows) {
      jobMap.set(j.id, { deviceBrand: j.deviceBrand, deviceModel: j.deviceModel, issueDescription: j.issueDescription });
    }
  }

  // Format
  const formatted = data.map((r) => {
    const reply = repliesMap.get(r.id);
    const media = mediaMap.get(r.id) ?? [];
    const job = r.jobId ? jobMap.get(r.jobId) : null;

    return {
      id: r.id,
      customerName: maskName(r.customerName),
      rating: r.rating,
      text: r.text ?? null,
      isReported: r.isReported,
      createdAt: r.createdAt?.toISOString() ?? null,
      job: job ? {
        deviceBrand: job.deviceBrand,
        deviceModel: job.deviceModel,
        issueDescription: job.issueDescription,
      } : null,
      reply: reply ? {
        text: reply.text,
        createdAt: reply.createdAt?.toISOString() ?? null,
      } : null,
      media: media.map((m) => ({
        id: m.id,
        type: m.type,
        url: m.url,
        thumbUrl: m.thumbUrl ?? null,
      })),
    };
  });

  const lastItem = data[data.length - 1];
  const nextCursor = hasMore && lastItem
    ? `${lastItem.createdAt?.toISOString() ?? ''}|${lastItem.id}`
    : null;

  return { data: formatted, hasMore, nextCursor };
}

// ─── Reply to a review ───

export async function replyToReview(opts: {
  reviewId: string;
  shopId: string;
  userId: string;
  text: string;
}) {
  const { reviewId, shopId, userId, text } = opts;

  // Verify review belongs to shop
  const [review] = await db
    .select({ id: reviews.id, shopId: reviews.shopId })
    .from(reviews)
    .where(eq(reviews.id, reviewId))
    .limit(1);

  if (!review) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Review not found');
  }
  if (review.shopId !== shopId) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'You can only reply to reviews for your own shop');
  }

  // Check existing reply
  const [existing] = await db
    .select({ id: reviewReplies.id })
    .from(reviewReplies)
    .where(eq(reviewReplies.reviewId, reviewId))
    .limit(1);

  if (existing) {
    throw new AppError(409, ErrorCode.CONFLICT, 'A reply already exists for this review');
  }

  const [reply] = await db
    .insert(reviewReplies)
    .values({
      reviewId,
      shopId,
      replierUserId: userId,
      text,
    })
    .returning();

  return {
    id: reply.id,
    reviewId: reply.reviewId,
    text: reply.text,
    createdAt: reply.createdAt?.toISOString() ?? null,
  };
}

// ─── Report a review ───

export async function reportReview(opts: {
  reviewId: string;
  shopId: string;
  userId: string;
  reason: string;
  notes?: string;
}) {
  const { reviewId, shopId, userId, reason, notes } = opts;

  // Verify review belongs to shop
  const [review] = await db
    .select({ id: reviews.id, shopId: reviews.shopId })
    .from(reviews)
    .where(eq(reviews.id, reviewId))
    .limit(1);

  if (!review) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Review not found');
  }
  if (review.shopId !== shopId) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'You can only report reviews for your own shop');
  }

  // Insert report
  const [report] = await db
    .insert(reviewReports)
    .values({
      reviewId,
      reporterUserId: userId,
      shopId,
      reason,
      notes: notes ?? null,
    })
    .returning();

  // Mark review as reported
  await db
    .update(reviews)
    .set({ isReported: true, updatedAt: new Date() })
    .where(eq(reviews.id, reviewId));

  return {
    id: report.id,
    reviewId: report.reviewId,
    reason: report.reason,
    createdAt: report.createdAt?.toISOString() ?? null,
  };
}

// ─── Create review (public — used by customer portal / test endpoint) ───

export async function createReview(opts: {
  shopId: string;
  customerId: string;
  customerName: string;
  jobId?: string;
  rating: number;
  text?: string;
}) {
  if (opts.rating < 1 || opts.rating > 5) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Rating must be between 1 and 5');
  }

  const [review] = await db
    .insert(reviews)
    .values({
      shopId: opts.shopId,
      customerId: opts.customerId,
      customerName: opts.customerName,
      jobId: opts.jobId ?? null,
      rating: opts.rating,
      text: opts.text ?? null,
    })
    .returning();

  return {
    id: review.id,
    shopId: review.shopId,
    rating: review.rating,
    text: review.text,
    createdAt: review.createdAt?.toISOString() ?? null,
  };
}

// ─── Customer: create review for a completed job ───

export async function createCustomerReview(opts: {
  jobId: string;
  customerId: string;
  rating: number;
  text?: string;
  mediaUrls?: string[];
}) {
  const { jobId, customerId, rating, text, mediaUrls } = opts;

  if (rating < 1 || rating > 5) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Rating must be between 1 and 5');
  }

  // Verify job exists, belongs to customer, and is completed
  const [job] = await db
    .select({
      id: jobs.id,
      customerId: jobs.customerId,
      customerName: jobs.customerName,
      shopId: jobs.shopId,
      status: jobs.status,
      deviceModel: jobs.deviceModel,
      issueDescription: jobs.issueDescription,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!job) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');
  }
  if (job.customerId !== customerId) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This job does not belong to you');
  }
  if (!['COMPLETED', 'DISPUTED', 'READY'].includes(job.status)) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'You can only review completed jobs');
  }

  // Check unique constraint: one review per job per customer
  const [existing] = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(and(eq(reviews.jobId, jobId), eq(reviews.customerId, customerId)))
    .limit(1);

  if (existing) {
    throw new AppError(409, ErrorCode.CONFLICT, 'You have already reviewed this job');
  }

  // Create review
  const [review] = await db
    .insert(reviews)
    .values({
      shopId: job.shopId,
      customerId,
      customerName: job.customerName,
      jobId,
      rating,
      text: text?.trim() || null,
    })
    .returning();

  // Insert media if provided
  if (mediaUrls && mediaUrls.length > 0) {
    await db.insert(reviewMedia).values(
      mediaUrls.map((url) => ({
        reviewId: review.id,
        type: url.match(/\.(mp4|mov|webm)$/i) ? 'VIDEO' as const : 'IMAGE' as const,
        url,
      })),
    );
  }

  // Emit Socket.IO event to shop
  try {
    await notifyShop({
      shopId: job.shopId,
      event: 'review:new',
      payload: {
        id: review.id,
        shopId: job.shopId,
        rating,
        text: text?.trim() || null,
        customerName: job.customerName,
        deviceModel: job.deviceModel,
      },
      push: { title: 'New Review!', body: `${job.customerName} left a ${rating}-star review.`, data: { screen: 'reviews', reviewId: review.id } },
      persist: {
        category: 'review',
        title: 'New Review!',
        body: `${job.customerName} left a ${rating}-star review.`,
        data: { screen: 'reviews', reviewId: review.id },
      },
    });
  } catch {}

  return {
    id: review.id,
    shopId: review.shopId,
    rating: review.rating,
    text: review.text,
    createdAt: review.createdAt?.toISOString() ?? null,
  };
}

// ─── Customer: list own reviews ───

export async function listCustomerReviews(customerId: string) {
  const rows = await db
    .select({
      id: reviews.id,
      shopId: reviews.shopId,
      shopName: shops.name,
      shopLogoUrl: shops.logoUrl,
      jobId: reviews.jobId,
      rating: reviews.rating,
      text: reviews.text,
      createdAt: reviews.createdAt,
    })
    .from(reviews)
    .leftJoin(shops, eq(reviews.shopId, shops.id))
    .where(eq(reviews.customerId, customerId))
    .orderBy(desc(reviews.createdAt));

  // Get job summaries for all reviews
  const jobIds = rows.filter((r) => r.jobId).map((r) => r.jobId!);
  const jobMap = new Map<string, { deviceModel: string; issueDescription: string }>();
  if (jobIds.length > 0) {
    const jobRows = await db
      .select({
        id: jobs.id,
        deviceModel: jobs.deviceModel,
        issueDescription: jobs.issueDescription,
      })
      .from(jobs)
      .where(sql`${jobs.id} IN (${sql.join(jobIds.map(id => sql`${id}::uuid`), sql`, `)})`);
    for (const j of jobRows) {
      jobMap.set(j.id, { deviceModel: j.deviceModel, issueDescription: j.issueDescription });
    }
  }

  // Load replies
  const reviewIds = rows.map((r) => r.id);
  const repliesMap = new Map<string, { text: string; createdAt: string | null }>();
  if (reviewIds.length > 0) {
    const replyRows = await db
      .select()
      .from(reviewReplies)
      .where(sql`${reviewReplies.reviewId} IN (${sql.join(reviewIds.map(id => sql`${id}::uuid`), sql`, `)})`);
    for (const r of replyRows) {
      repliesMap.set(r.reviewId, { text: r.text, createdAt: r.createdAt?.toISOString() ?? null });
    }
  }

  return rows.map((r) => {
    const job = r.jobId ? jobMap.get(r.jobId) : null;
    const reply = repliesMap.get(r.id);
    return {
      id: r.id,
      shopId: r.shopId,
      shopName: r.shopName ?? 'Shop',
      shopLogoUrl: r.shopLogoUrl ?? null,
      rating: r.rating,
      text: r.text ?? null,
      createdAt: r.createdAt?.toISOString() ?? null,
      job: job ? { deviceModel: job.deviceModel, issueDescription: job.issueDescription } : null,
      reply: reply ?? null,
    };
  });
}

// ─── Check if customer already reviewed a job ───

export async function hasCustomerReviewedJob(jobId: string, customerId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(and(eq(reviews.jobId, jobId), eq(reviews.customerId, customerId)))
    .limit(1);
  return !!existing;
}
