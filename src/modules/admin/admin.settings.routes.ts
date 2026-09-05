import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import { getSettings, updateSettings, getApiKeys, updateApiKeys } from './admin.settings.service.js';

const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/settings', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (_req, reply) => {
      const settings = await getSettings();
      return reply.send(successResponse(settings));
    },
  });

  fastify.patch('/admin/settings', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = req.body as Record<string, any>;
      if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
        return reply.status(400).send({ success: false, error: { code: 'BAD_REQUEST', message: 'Request body is required' } });
      }
      const settings = await updateSettings(body);
      await logAudit(req.user!.userId, 'Updated system settings', 'settings', undefined, JSON.stringify(body));
      return reply.send(successResponse(settings));
    },
  });

  // ─── API Keys (Cloudinary & Stripe) ───

  fastify.get('/admin/settings/api-keys', {
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (_req, reply) => {
      const keys = await getApiKeys();
      return reply.send(successResponse(keys));
    },
  });

  fastify.patch('/admin/settings/api-keys', {
    preHandler: auth,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = req.body as any;
      const keys = await updateApiKeys(body);
      // Audit log — don't log the actual key values
      const changedKeys = Object.keys(body).filter((k) => body[k]);
      await logAudit(req.user!.userId, `Updated API keys: ${changedKeys.join(', ')}`, 'settings');
      return reply.send(successResponse(keys));
    },
  });
};

export default settingsRoutes;
