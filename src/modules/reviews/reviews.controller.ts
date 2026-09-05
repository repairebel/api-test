import { FastifyRequest, FastifyReply } from 'fastify';
import {
  getReviewSummary,
  listReviews,
  replyToReview,
  reportReview,
  createReview,
  createCustomerReview,
  listCustomerReviews,
} from './reviews.service.js';
import { successResponse } from '../../plugins/error-handler.plugin.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { getIO } from '../../lib/socket.js';

// GET /v1/shops/me/reviews/summary?range=30d
export async function reviewSummaryHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const { range } = request.query as Record<string, string>;

  let rangeDays: number | undefined;
  if (range) {
    const match = range.match(/^(\d+)d$/);
    if (match) {
      rangeDays = parseInt(match[1], 10);
    }
  }

  const summary = await getReviewSummary(shopId, rangeDays);
  return reply.send(successResponse(summary));
}

// GET /v1/shops/me/reviews?rating=&withText=&sort=&limit=&cursor=
export async function listReviewsHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const {
    rating,
    withText,
    sort = 'newest',
    limit = '20',
    cursor,
  } = request.query as Record<string, string>;

  const parsedLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const parsedRating = rating ? parseInt(rating, 10) : undefined;
  if (parsedRating !== undefined && (parsedRating < 1 || parsedRating > 5)) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Rating filter must be 1-5');
  }

  const validSorts = ['newest', 'oldest', 'highest', 'lowest'] as const;
  const parsedSort = validSorts.includes(sort as any) ? (sort as typeof validSorts[number]) : 'newest';

  const result = await listReviews({
    shopId,
    rating: parsedRating,
    withText: withText === 'true',
    sort: parsedSort,
    limit: parsedLimit,
    cursor: cursor || undefined,
  });

  return reply.send(successResponse(result));
}

// POST /v1/reviews/:id/reply
export async function replyToReviewHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const shopId = request.user!.shopId;
  const userId = request.user!.userId;
  const { text } = request.body as { text: string };

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Reply text is required');
  }
  if (text.trim().length > 2000) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Reply text must be 2000 characters or fewer');
  }

  const result = await replyToReview({
    reviewId: id,
    shopId,
    userId,
    text: text.trim(),
  });

  return reply.status(201).send(successResponse(result));
}

// POST /v1/reviews/:id/report
export async function reportReviewHandler(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const shopId = request.user!.shopId;
  const userId = request.user!.userId;
  const { reason, notes } = request.body as { reason: string; notes?: string };

  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Report reason is required');
  }
  if (reason.trim().length > 100) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Reason must be 100 characters or fewer');
  }
  if (notes && typeof notes === 'string' && notes.length > 1000) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Notes must be 1000 characters or fewer');
  }

  const result = await reportReview({
    reviewId: id,
    shopId,
    userId,
    reason: reason.trim(),
    notes: notes?.trim(),
  });

  return reply.status(201).send(successResponse(result));
}

// POST /v1/test/reviews (public test endpoint — creates a review and emits Socket.IO)
export async function createReviewTestHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as {
    shopId: string;
    customerId: string;
    customerName: string;
    jobId?: string;
    rating: number;
    text?: string;
  };

  if (!body.shopId || !body.customerId || !body.customerName || !body.rating) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'shopId, customerId, customerName, and rating are required');
  }

  const result = await createReview(body);

  // Emit Socket.IO event with customer name for banner notification
  try {
    getIO().to(`shop:${body.shopId}`).emit('review:new', {
      ...result,
      customerName: body.customerName,
    });
  } catch {
    // Socket.IO may not be initialized in tests
  }

  return reply.status(201).send(successResponse(result));
}

// ── Customer: POST /v1/customer/jobs/:jobId/review ──
export async function createCustomerReviewHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.userType !== 'CUSTOMER') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This endpoint requires a customer account');
  }

  const { jobId } = request.params as { jobId: string };
  const { rating, text, mediaUrls } = request.body as {
    rating: number;
    text?: string;
    mediaUrls?: string[];
  };

  if (!rating || typeof rating !== 'number') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Rating (1-5) is required');
  }

  const result = await createCustomerReview({
    jobId,
    customerId: request.user.userId,
    rating,
    text,
    mediaUrls,
  });

  return reply.status(201).send(successResponse(result));
}

// ── Customer: GET /v1/customer/reviews ──
export async function listCustomerReviewsHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.userType !== 'CUSTOMER') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This endpoint requires a customer account');
  }

  const data = await listCustomerReviews(request.user.userId);
  return reply.send(successResponse(data));
}
