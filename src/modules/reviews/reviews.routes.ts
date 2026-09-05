import { FastifyPluginAsync } from 'fastify';
import { requireApproved } from '../../plugins/require-approved.plugin.js';
import { requireRole } from '../../plugins/auth.plugin.js';
import {
  reviewSummaryHandler,
  listReviewsHandler,
  replyToReviewHandler,
  reportReviewHandler,
  createReviewTestHandler,
  createCustomerReviewHandler,
  listCustomerReviewsHandler,
} from './reviews.controller.js';

const reviewsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Review summary (avg, breakdown) ──
  fastify.get('/shops/me/reviews/summary', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: reviewSummaryHandler,
  });

  // ── List reviews (paginated, filterable) ──
  fastify.get('/shops/me/reviews', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: listReviewsHandler,
  });

  // ── Reply to a review (OWNER / MANAGER only) ──
  fastify.post('/reviews/:id/reply', {
    preHandler: [fastify.authenticate, requireApproved, requireRole('OWNER', 'MANAGER')],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: replyToReviewHandler,
  });

  // ── Report a review ──
  fastify.post('/reviews/:id/report', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: reportReviewHandler,
  });

  // ── Customer: create review for a completed job ──
  fastify.post('/customer/jobs/:jobId/review', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: createCustomerReviewHandler,
  });

  // ── Customer: list own reviews ──
  fastify.get('/customer/reviews', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: listCustomerReviewsHandler,
  });

  // ── Test endpoint: create a review (public, no auth) ──
  fastify.post('/test/reviews', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: createReviewTestHandler,
  });
};

export default reviewsRoutes;
