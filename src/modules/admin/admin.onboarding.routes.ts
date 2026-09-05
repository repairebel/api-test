import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import {
  listOnboardingSubmissions,
  getOnboardingDetail,
  approveOnboarding,
  rejectOnboarding,
} from './admin.onboarding.service.js';

const onboardingRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/onboarding', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listOnboardingSubmissions({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        status: q.status,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  fastify.get('/admin/onboarding/:shopId', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { shopId } = req.params as { shopId: string };
      const detail = await getOnboardingDetail(shopId);
      return reply.send(successResponse(detail));
    },
  });

  fastify.post('/admin/onboarding/:shopId/approve', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { shopId } = req.params as { shopId: string };
      const result = await approveOnboarding(shopId);
      await logAudit(req.user!.userId, `Approved onboarding for shop ${shopId}`, 'onboarding', shopId);
      return reply.send(successResponse(result));
    },
  });

  fastify.post('/admin/onboarding/:shopId/reject', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { shopId } = req.params as { shopId: string };
      const { reason } = req.body as { reason: string };
      const result = await rejectOnboarding(shopId, reason);
      await logAudit(req.user!.userId, `Rejected onboarding for shop ${shopId}: ${reason}`, 'onboarding', shopId);
      return reply.send(successResponse(result));
    },
  });
};

export default onboardingRoutes;
