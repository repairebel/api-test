import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { paginatedResponse } from '../../plugins/error-handler.plugin.js';
import { listAuditLogs } from './admin.audit.service.js';

const auditRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/audit-logs', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listAuditLogs({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        actionType: q.actionType,
        adminUserId: q.adminUserId,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });
};

export default auditRoutes;
