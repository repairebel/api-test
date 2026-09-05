import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse } from '../../plugins/error-handler.plugin.js';
import {
  adminSendNotification,
  adminSendEmail,
  searchUsersForNotification,
  searchShopsForNotification,
} from './admin.broadcast.service.js';

const broadcastRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  /**
   * POST /admin/notifications/send
   * Send a custom notification to a targeted audience.
   */
  fastify.post('/admin/notifications/send', {
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { target, userId, shopId, title, body, category } = req.body as {
        target: 'all_customers' | 'all_shops' | 'specific_customer' | 'specific_shop';
        userId?: string;
        shopId?: string;
        title: string;
        body: string;
        category?: string;
      };

      if (!target || !title || !body) {
        return reply.status(400).send({ success: false, message: 'target, title, and body are required' });
      }

      if (target === 'specific_customer' && !userId) {
        return reply.status(400).send({ success: false, message: 'userId is required for specific_customer' });
      }

      if (target === 'specific_shop' && !shopId) {
        return reply.status(400).send({ success: false, message: 'shopId is required for specific_shop' });
      }

      const result = await adminSendNotification({ target, userId, shopId, title, body, category });
      return reply.send(successResponse(result));
    },
  });

  /**
   * POST /admin/emails/send
   * Send branded email to audience/custom recipient.
   */
  fastify.post('/admin/emails/send', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { target, userId, shopId, email, title, body, category } = req.body as {
        target: 'all_customers' | 'all_shops' | 'specific_customer' | 'specific_shop' | 'specific_user' | 'custom_email';
        userId?: string;
        shopId?: string;
        email?: string;
        title: string;
        body: string;
        category?: string;
      };

      if (!target || !title || !body) {
        return reply.status(400).send({ success: false, message: 'target, title, and body are required' });
      }

      if ((target === 'specific_customer' || target === 'specific_user') && !userId) {
        return reply.status(400).send({ success: false, message: 'userId is required for this target' });
      }

      if (target === 'specific_shop' && !shopId) {
        return reply.status(400).send({ success: false, message: 'shopId is required for specific_shop' });
      }

      if (target === 'custom_email' && !email) {
        return reply.status(400).send({ success: false, message: 'email is required for custom_email' });
      }

      const result = await adminSendEmail({ target, userId, shopId, email, title, body, category });
      return reply.send(successResponse(result));
    },
  });

  /**
   * GET /admin/notifications/search-users?q=...&type=CUSTOMER|SHOP_OWNER
   * Search users for the notification target picker.
   */
  fastify.get('/admin/notifications/search-users', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { q, type } = req.query as { q?: string; type?: string };
      if (!q || q.length < 2) {
        return reply.send(successResponse([]));
      }
      const userType = type === 'SHOP_OWNER' ? 'SHOP_OWNER' : 'CUSTOMER';
      const results = await searchUsersForNotification(q, userType as 'CUSTOMER' | 'SHOP_OWNER');
      return reply.send(successResponse(results));
    },
  });

  /**
   * GET /admin/notifications/search-shops?q=...
   * Search shops for the notification target picker.
   */
  fastify.get('/admin/notifications/search-shops', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { q } = req.query as { q?: string };
      if (!q || q.length < 2) {
        return reply.send(successResponse([]));
      }
      const results = await searchShopsForNotification(q);
      return reply.send(successResponse(results));
    },
  });
};

export default broadcastRoutes;
