import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import {
  listDeviceModels,
  getDeviceModel,
  createDeviceModel,
  updateDeviceModel,
  deleteDeviceModel,
} from './admin.device-models.service.js';

const deviceModelsRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/device-models', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listDeviceModels({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        search: q.search,
        brand: q.brand,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  fastify.get('/admin/device-models/:id', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const model = await getDeviceModel(id);
      return reply.send(successResponse(model));
    },
  });

  fastify.post('/admin/device-models', {
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = req.body as { brand: string; deviceType: string; modelName: string; modelNumber?: string };
      const model = await createDeviceModel(body);
      await logAudit(req.user!.userId, `Created device model ${model.modelName}`, 'settings', model.id);
      return reply.status(201).send(successResponse(model));
    },
  });

  fastify.patch('/admin/device-models/:id', {
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as Partial<{ brand: string; deviceType: string; modelName: string; modelNumber: string }>;
      const model = await updateDeviceModel(id, body);
      await logAudit(req.user!.userId, `Updated device model ${id}`, 'settings', id);
      return reply.send(successResponse(model));
    },
  });

  fastify.delete('/admin/device-models/:id', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await deleteDeviceModel(id);
      await logAudit(req.user!.userId, `Deleted device model ${id}`, 'settings', id);
      return reply.send(successResponse(result));
    },
  });
};

export default deviceModelsRoutes;
