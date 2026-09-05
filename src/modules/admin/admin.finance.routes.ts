import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse } from '../../plugins/error-handler.plugin.js';
import {
  getFinanceSummary,
  getMonthlyRevenue,
  getRefundTrend,
} from './admin.finance.service.js';

const financeRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/finance/summary', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (_req, reply) => {
      const data = await getFinanceSummary();
      return reply.send(successResponse(data));
    },
  });

  fastify.get('/admin/finance/monthly-revenue', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (_req, reply) => {
      const data = await getMonthlyRevenue();
      return reply.send(successResponse(data));
    },
  });

  fastify.get('/admin/finance/refund-trend', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (_req, reply) => {
      const data = await getRefundTrend();
      return reply.send(successResponse(data));
    },
  });
};

export default financeRoutes;
