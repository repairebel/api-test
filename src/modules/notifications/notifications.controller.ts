import { FastifyRequest, FastifyReply } from 'fastify';
import {
  registerPushToken,
  unregisterPushToken,
  getUserNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from './notifications.service.js';
import { successResponse } from '../../plugins/error-handler.plugin.js';

interface RegisterBody {
  token: string;
  platform: string;
  appType: 'STORE' | 'CUSTOMER';
}

interface UnregisterBody {
  token: string;
}

export async function registerPushTokenHandler(
  request: FastifyRequest<{ Body: RegisterBody }>,
  reply: FastifyReply,
) {
  const { token, platform, appType } = request.body;

  if (!token || !platform || !appType) {
    return reply.status(400).send({ error: 'token, platform and appType are required' });
  }

  if (!['STORE', 'CUSTOMER'].includes(appType)) {
    return reply.status(400).send({ error: 'appType must be STORE or CUSTOMER' });
  }

  if (!['ios', 'android'].includes(platform)) {
    return reply.status(400).send({ error: 'platform must be ios or android' });
  }

  await registerPushToken(request.user!.userId, token, platform, appType);
  return reply.status(200).send(successResponse({ registered: true }));
}

export async function unregisterPushTokenHandler(
  request: FastifyRequest<{ Body: UnregisterBody }>,
  reply: FastifyReply,
) {
  const { token } = request.body;

  if (!token) {
    return reply.status(400).send({ error: 'token is required' });
  }

  await unregisterPushToken(request.user!.userId, token);
  return reply.status(200).send(successResponse({ unregistered: true }));
}

// ─── Notification CRUD handlers ─────────────────────────────

export async function listNotificationsHandler(
  request: FastifyRequest<{ Querystring: { page?: string; limit?: string; category?: string; read?: string } }>,
  reply: FastifyReply,
) {
  const userId = request.user!.userId;
  const page = request.query.page ? parseInt(request.query.page, 10) : 1;
  const limit = request.query.limit ? parseInt(request.query.limit, 10) : 30;
  const category = request.query.category;
  const read = request.query.read !== undefined ? request.query.read === 'true' : undefined;

  const rows = await getUserNotifications(userId, { page, limit, category, read });
  return reply.send(successResponse(rows));
}

export async function unreadCountHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.user!.userId;
  const count = await getUnreadCount(userId);
  return reply.send(successResponse({ count }));
}

export async function markReadHandler(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const userId = request.user!.userId;
  const { id } = request.params;
  const ok = await markNotificationRead(id, userId);
  if (!ok) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Notification not found' } });
  return reply.send(successResponse({ marked: true }));
}

export async function markAllReadHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.user!.userId;
  await markAllNotificationsRead(userId);
  return reply.send(successResponse({ marked: true }));
}
