import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import {
  listReviews,
  getReviewReports,
  hideReview,
  unhideReview,
  deleteReview,
} from './admin.reviews.service.js';

const reviewsRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/reviews', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listReviews({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        reportedOnly: q.reportedOnly === 'true',
        hidden: q.hidden === 'true' ? true : q.hidden === 'false' ? false : undefined,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  fastify.get('/admin/reviews/reports', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await getReviewReports({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  fastify.post('/admin/reviews/:id/hide', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await hideReview(id);
      await logAudit(req.user!.userId, `Hid review ${id}`, 'review', id);
      return reply.send(successResponse(result));
    },
  });

  fastify.post('/admin/reviews/:id/unhide', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await unhideReview(id);
      await logAudit(req.user!.userId, `Unhid review ${id}`, 'review', id);
      return reply.send(successResponse(result));
    },
  });

  fastify.delete('/admin/reviews/:id', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await deleteReview(id);
      await logAudit(req.user!.userId, `Deleted review ${id}`, 'review', id);
      return reply.send(successResponse(result));
    },
  });
};

export default reviewsRoutes;
