import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import {
  listShops,
  getShopById,
  updateShop,
  suspendShop,
  activateShop,
  getShopJobs,
  getShopEarnings,
  deleteShopCompletely,
  setShopPriority,
  getNearbyPriorities,
} from './admin.shops.service.js';

const shopsRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/shops', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listShops({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        search: q.search,
        status: q.status,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  fastify.get('/admin/shops/:shopId', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { shopId } = req.params as { shopId: string };
      const shop = await getShopById(shopId);
      return reply.send(successResponse(shop));
    },
  });

  fastify.patch('/admin/shops/:shopId', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { shopId } = req.params as { shopId: string };
      const body = req.body as Record<string, any>;
      const result = await updateShop(shopId, body);
      await logAudit(req.user!.userId, `Updated shop ${shopId}`, 'store', shopId);
      return reply.send(successResponse(result));
    },
  });

  fastify.post('/admin/shops/:shopId/suspend', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { shopId } = req.params as { shopId: string };
      const result = await suspendShop(shopId);
      await logAudit(req.user!.userId, `Suspended shop ${shopId}`, 'store', shopId);
      return reply.send(successResponse(result));
    },
  });

  fastify.post('/admin/shops/:shopId/activate', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { shopId } = req.params as { shopId: string };
      const result = await activateShop(shopId);
      await logAudit(req.user!.userId, `Activated shop ${shopId}`, 'store', shopId);
      return reply.send(successResponse(result));
    },
  });

  fastify.get('/admin/shops/:shopId/jobs', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { shopId } = req.params as { shopId: string };
      const q = req.query as any;
      const result = await getShopJobs(shopId, {
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  fastify.get('/admin/shops/:shopId/earnings', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { shopId } = req.params as { shopId: string };
      const data = await getShopEarnings(shopId);
      return reply.send(successResponse(data));
    },
  });

  fastify.delete('/admin/shops/:shopId', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { shopId } = req.params as { shopId: string };
      const result = await deleteShopCompletely(shopId);
      await logAudit(req.user!.userId, `Deleted shop ${shopId} (${result.shopName})`, 'store', shopId);
      return reply.send(successResponse(result));
    },
  });

  /* ── Priority management ─────────────────────────────────── */

  fastify.post('/admin/shops/:shopId/priority', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { shopId } = req.params as { shopId: string };
      const { priorityEnabled, priorityLevel } = req.body as {
        priorityEnabled: boolean;
        priorityLevel: number | null;
      };
      const result = await setShopPriority(shopId, priorityEnabled, priorityLevel);
      await logAudit(
        req.user!.userId,
        priorityEnabled
          ? `Set priority ${priorityLevel} for shop ${shopId}`
          : `Disabled priority for shop ${shopId}`,
        'store',
        shopId,
      );
      return reply.send(successResponse(result));
    },
  });

  fastify.get('/admin/shops/:shopId/nearby-priorities', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { shopId } = req.params as { shopId: string };
      const result = await getNearbyPriorities(shopId);
      return reply.send(successResponse(result));
    },
  });
};

export default shopsRoutes;
