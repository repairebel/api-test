import { FastifyPluginAsync } from 'fastify';
import { requireApproved } from '../../plugins/require-approved.plugin.js';
import {
  listInventoryHandler,
  createInventoryHandler,
  getInventoryHandler,
  listMovementsHandler,
  stockInHandler,
  stockOutHandler,
  adjustHandler,
  updatePricingHandler,
  deleteInventoryHandler,
  searchDeviceModelsHandler,
  getDeviceModelBrandsHandler,
} from './inventory.controller.js';

const inventoryRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Public: Device model search (no auth — used by customer portal too) ──
  fastify.get('/device-models/search', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    handler: searchDeviceModelsHandler,
  });

  fastify.get('/device-models/brands', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: getDeviceModelBrandsHandler,
  });

  // ── List inventory for current shop ──
  fastify.get('/shops/me/inventory', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: listInventoryHandler,
  });

  // ── Create inventory item ──
  fastify.post('/shops/me/inventory', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: createInventoryHandler,
  });

  // ── Get single inventory item ──
  fastify.get('/inventory/:itemId', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: getInventoryHandler,
  });

  // ── List movements for an item ──
  fastify.get('/inventory/:itemId/movements', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: listMovementsHandler,
  });

  // ── Stock in ──
  fastify.post('/inventory/:itemId/stock-in', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: stockInHandler,
  });

  // ── Stock out ──
  fastify.post('/inventory/:itemId/stock-out', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: stockOutHandler,
  });

  // ── Adjust stock ──
  fastify.post('/inventory/:itemId/adjust', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: adjustHandler,
  });

  // ── Update pricing ──
  fastify.patch('/inventory/:itemId/pricing', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: updatePricingHandler,
  });

  // ── Delete inventory item ──
  fastify.delete('/inventory/:itemId', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: deleteInventoryHandler,
  });
};

export default inventoryRoutes;
