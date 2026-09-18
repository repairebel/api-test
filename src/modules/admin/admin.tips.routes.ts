import { FastifyPluginAsync } from 'fastify';
import { requireAdminRole, requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse } from '../../plugins/error-handler.plugin.js';
import { getAdminTipReport } from './admin.tips.service.js';

const tipsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/admin/tips', {
    preHandler: [fastify.authenticate, requireUserType('ADMIN'), requireAdminRole('super_admin')],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { range, from, to } = req.query as { range?: string; from?: string; to?: string };
      return reply.send(successResponse(await getAdminTipReport({ range, from, to })));
    },
  });
};

export default tipsRoutes;
