import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import {
  listUsers,
  getUserById,
  updateUser,
  resetUserPassword,
  suspendUser,
  activateUser,
  deleteUser,
} from './admin.users.service.js';

const usersRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/users', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listUsers({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        search: q.search,
        userType: q.userType,
        status: q.status,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  fastify.get('/admin/users/:id', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const user = await getUserById(id);
      return reply.send(successResponse(user));
    },
  });

  fastify.patch('/admin/users/:id', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, any>;
      const result = await updateUser(id, body);
      await logAudit(req.user!.userId, `Updated user ${id}`, 'user', id);
      return reply.send(successResponse(result));
    },
  });

  fastify.post('/admin/users/:id/reset-password', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const { newPassword } = req.body as { newPassword: string };
      const result = await resetUserPassword(id, newPassword);
      await logAudit(req.user!.userId, `Reset password for user ${id}`, 'user', id);
      return reply.send(successResponse(result));
    },
  });

  fastify.post('/admin/users/:id/suspend', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await suspendUser(id);
      await logAudit(req.user!.userId, `Suspended user ${id}`, 'user', id);
      return reply.send(successResponse(result));
    },
  });

  fastify.post('/admin/users/:id/activate', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await activateUser(id);
      await logAudit(req.user!.userId, `Activated user ${id}`, 'user', id);
      return reply.send(successResponse(result));
    },
  });

  fastify.delete('/admin/users/:id', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await deleteUser(id);
      await logAudit(req.user!.userId, `Deleted user ${id}`, 'user', id);
      return reply.send(successResponse(result));
    },
  });
};

export default usersRoutes;
