import { FastifyPluginAsync } from 'fastify';
import {
  registerPushTokenHandler,
  unregisterPushTokenHandler,
  listNotificationsHandler,
  unreadCountHandler,
  markReadHandler,
  markAllReadHandler,
} from './notifications.controller.js';

const notificationsRoutes: FastifyPluginAsync = async (fastify) => {
  // ─── Push token endpoints ──────────────────────────────────
  // Register push token (called after login/app start)
  fastify.post('/notifications/push-token', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: registerPushTokenHandler,
  });

  // Unregister push token (called on logout)
  fastify.delete('/notifications/push-token', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: unregisterPushTokenHandler,
  });

  // ─── Notification CRUD endpoints ───────────────────────────
  // List notifications (paginated, filterable)
  fastify.get('/notifications', {
    preHandler: [fastify.authenticate],
    handler: listNotificationsHandler,
  });

  // Get unread count
  fastify.get('/notifications/unread-count', {
    preHandler: [fastify.authenticate],
    handler: unreadCountHandler,
  });

  // Mark single notification as read
  fastify.patch('/notifications/:id/read', {
    preHandler: [fastify.authenticate],
    handler: markReadHandler,
  });

  // Mark all notifications as read
  fastify.patch('/notifications/read-all', {
    preHandler: [fastify.authenticate],
    handler: markAllReadHandler,
  });
};

export default notificationsRoutes;
