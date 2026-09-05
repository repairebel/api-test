import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import {
  listOrders,
  getOrderById,
  getOrderPayment,
  refundOrder,
} from './admin.orders.service.js';

const ordersRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/orders', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listOrders({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        search: q.search,
        status: q.status,
        paymentStatus: q.paymentStatus,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  fastify.get('/admin/orders/:id', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const order = await getOrderById(id);
      return reply.send(successResponse(order));
    },
  });

  fastify.get('/admin/orders/:id/payment', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const data = await getOrderPayment(id);
      return reply.send(successResponse(data));
    },
  });

  fastify.post('/admin/orders/:id/refund', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await refundOrder(id);
      await logAudit(req.user!.userId, `Refunded order ${id}`, 'finance', id);
      return reply.send(successResponse(result));
    },
  });
};

export default ordersRoutes;
