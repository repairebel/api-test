import { FastifyPluginAsync } from 'fastify';
import { requireAdminRole, requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse } from '../../plugins/error-handler.plugin.js';
import { getSystemHealth } from '../../lib/system-health.js';

const systemHealthRoutes: FastifyPluginAsync = async (fastify) => {
  const superAdminOnly = [fastify.authenticate, requireUserType('ADMIN'), requireAdminRole('super_admin')];

  fastify.get('/admin/system-health', {
    preHandler: superAdminOnly,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { fresh } = request.query as { fresh?: string };
      const report = await getSystemHealth(fresh === 'true');
      return reply.header('Cache-Control', 'no-store').send(successResponse(report));
    },
  });
};

export default systemHealthRoutes;
