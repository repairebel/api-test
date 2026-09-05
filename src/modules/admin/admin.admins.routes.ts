import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import {
  listAdmins,
  createAdmin,
  updateAdminRole,
  suspendAdmin,
  activateAdmin,
  deleteAdmin,
  updateAdmin,
} from './admin.admins.service.js';

const adminsRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/admins', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listAdmins({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  fastify.post('/admin/admins', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = req.body as { email: string; password: string; name: string; role: 'super_admin' | 'admin' | 'moderator' };
      const admin = await createAdmin(body);
      await logAudit(req.user!.userId, `Created admin ${body.email} with role ${body.role}`, 'admin', admin.id);
      return reply.status(201).send(successResponse(admin));
    },
  });

  fastify.patch('/admin/admins/:id/role', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const { role } = req.body as { role: 'super_admin' | 'admin' | 'moderator' };
      const result = await updateAdminRole(id, role);
      await logAudit(req.user!.userId, `Changed admin ${id} role to ${role}`, 'admin', id);
      return reply.send(successResponse(result));
    },
  });

  fastify.post('/admin/admins/:id/suspend', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await suspendAdmin(id);
      await logAudit(req.user!.userId, `Suspended admin ${id}`, 'admin', id);
      return reply.send(successResponse(result));
    },
  });

  fastify.post('/admin/admins/:id/activate', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await activateAdmin(id);
      await logAudit(req.user!.userId, `Activated admin ${id}`, 'admin', id);
      return reply.send(successResponse(result));
    },
  });

  fastify.delete('/admin/admins/:id', {
    preHandler: auth,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await deleteAdmin(id);
      await logAudit(req.user!.userId, `Deleted admin ${id}`, 'admin', id);
      return reply.send(successResponse(result));
    },
  });

  fastify.patch('/admin/admins/:id', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { email?: string; password?: string; name?: string; role?: 'super_admin' | 'admin' | 'moderator' };
      const result = await updateAdmin(id, body);
      await logAudit(req.user!.userId, `Updated admin ${id}`, 'admin', id);
      return reply.send(successResponse(result));
    },
  });
};

export default adminsRoutes;
