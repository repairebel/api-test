import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import {
  listPayouts,
  getPayoutById,
  markPayoutCompleted,
} from './admin.payouts.service.js';

const payoutsRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/payouts', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listPayouts({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        status: q.status,
        shopId: q.shopId,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  fastify.get('/admin/payouts/:id', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const payout = await getPayoutById(id);
      return reply.send(successResponse(payout));
    },
  });

  fastify.post('/admin/payouts/:id/complete', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await markPayoutCompleted(id);
      await logAudit(req.user!.userId, `Completed payout ${id}`, 'finance', id);
      return reply.send(successResponse(result));
    },
  });
};

export default payoutsRoutes;
