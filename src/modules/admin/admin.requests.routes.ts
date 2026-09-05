import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import {
  listRequests,
  getRequestById,
  getRequestDispatch,
  getRequestOffers,
  cancelRequest,
} from './admin.requests.service.js';

const requestsRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/requests', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listRequests({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        search: q.search,
        status: q.status,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  fastify.get('/admin/requests/:id', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const request = await getRequestById(id);
      return reply.send(successResponse(request));
    },
  });

  fastify.get('/admin/requests/:id/dispatch', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const data = await getRequestDispatch(id);
      return reply.send(successResponse(data));
    },
  });

  fastify.get('/admin/requests/:id/offers', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const data = await getRequestOffers(id);
      return reply.send(successResponse(data));
    },
  });

  fastify.post('/admin/requests/:id/cancel', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await cancelRequest(id);
      await logAudit(req.user!.userId, `Cancelled request ${id}`, 'order', id);
      return reply.send(successResponse(result));
    },
  });
};

export default requestsRoutes;
