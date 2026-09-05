import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import { getProfile, updateProfile, changePassword } from './admin.profile.service.js';

const profileRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/me', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const profile = await getProfile(req.user!.userId);
      return reply.send(successResponse(profile));
    },
  });

  fastify.patch('/admin/me', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = req.body as Partial<{ name: string; email: string; phone: string; avatarUrl: string }>;
      const profile = await updateProfile(req.user!.userId, body);
      await logAudit(req.user!.userId, 'Updated admin profile', 'admin');
      return reply.send(successResponse(profile));
    },
  });

  fastify.post('/admin/me/change-password', {
    preHandler: auth,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
      const result = await changePassword(req.user!.userId, currentPassword, newPassword);
      await logAudit(req.user!.userId, 'Changed password', 'auth');
      return reply.send(successResponse(result));
    },
  });
};

export default profileRoutes;
