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
import {
  repairPriceInputSchema,
  listDeviceModelPrices,
  createDeviceModelPrice,
  updateDeviceModelPrice,
  deactivateDeviceModelPrice,
  resetDeviceModelPrice,
} from './admin.repair-prices.service.js';

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

  fastify.get('/admin/device-models/:id/prices', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      return reply.send(successResponse(await listDeviceModelPrices(id)));
    },
  });

  fastify.post('/admin/device-models/:id/prices', {
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = repairPriceInputSchema.parse(req.body);
      const price = await createDeviceModelPrice(id, body, req.user!.userId);
      await logAudit(req.user!.userId, `Added repair price ${price.category}`, 'settings', id, JSON.stringify({ issueType: price.issueType, suggestedPriceCents: price.suggestedPriceCents }));
      return reply.status(201).send(successResponse(price));
    },
  });

  fastify.patch('/admin/device-models/:id/prices/:issueType', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id, issueType } = req.params as { id: string; issueType: string };
      const body = repairPriceInputSchema.parse({ ...(req.body as object), issueType });
      const price = await updateDeviceModelPrice(id, issueType, body, req.user!.userId);
      await logAudit(req.user!.userId, `Updated repair price ${price.category}`, 'settings', id, JSON.stringify({ issueType: price.issueType, suggestedPriceCents: price.suggestedPriceCents }));
      return reply.send(successResponse(price));
    },
  });

  fastify.post('/admin/device-models/:id/prices/:issueType/reset', {
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id, issueType } = req.params as { id: string; issueType: string };
      const price = await resetDeviceModelPrice(id, issueType);
      await logAudit(req.user!.userId, `Reset repair price ${issueType} to catalog`, 'settings', id);
      return reply.send(successResponse(price));
    },
  });

  fastify.delete('/admin/device-models/:id/prices/:issueType', {
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id, issueType } = req.params as { id: string; issueType: string };
      const price = await deactivateDeviceModelPrice(id, issueType, req.user!.userId);
      await logAudit(req.user!.userId, `Disabled repair price ${issueType}`, 'settings', id);
      return reply.send(successResponse(price));
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
