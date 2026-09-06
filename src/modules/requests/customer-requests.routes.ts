import { z } from 'zod';
import { getCustomerShopProfile } from './customer-shop-profile.js';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse } from '../../plugins/error-handler.plugin.js';
import { FastifyPluginAsync } from 'fastify';
import {
  issueTypesHandler,
  searchDeviceModelsHandler,
  customerMediaSignatureHandler,
  createCustomerRequestHandler,
  listCustomerRequestsHandler,
  getCustomerRequestHandler,
  priceEstimateHandler,
  acceptOfferHandler,
  confirmOfferPaymentHandler,
  rejectOfferHandler,
  cancelRequestHandler,
  listCustomerJobsHandler,
  getCustomerJobHandler,
  confirmJobHandler,
  updatePaymentMethodHandler,
  customerNearbyShopsHandler,
} from './customer-requests.controller.js';

const customerRequestsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/customer/shops/:shopId', {
    preHandler: [fastify.authenticate, requireUserType('CUSTOMER')],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { shopId } = z.object({ shopId: z.string().uuid() }).parse(request.params);
      const { page } = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }).parse(request.query);
      return reply.send(successResponse(await getCustomerShopProfile(shopId, page)));
    },
  });
  // ── Public catalog endpoints (no auth) ──
  // NOTE: /device-models/brands and /device-models/search are already
  //       registered in inventory.routes.ts — reuse those.

  fastify.get('/issue-types', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: issueTypesHandler,
  });

  fastify.get('/device-models', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: searchDeviceModelsHandler,
  });

  fastify.get('/price-estimate', {
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
    handler: priceEstimateHandler,
  });

  // ── Customer-authenticated endpoints ──

  fastify.post('/customer/media/cloudinary/signature', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: customerMediaSignatureHandler,
  });

  fastify.post('/customer/requests', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: createCustomerRequestHandler,
  });

  fastify.get('/customer/requests', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: listCustomerRequestsHandler,
  });

  fastify.get('/customer/requests/:requestId', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: getCustomerRequestHandler,
  });

  fastify.post('/customer/requests/:requestId/cancel', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: cancelRequestHandler,
  });

  // ── Offers ──

  fastify.post('/customer/offers/:offerId/accept', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: acceptOfferHandler,
  });

  fastify.post('/customer/offers/:offerId/reject', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: rejectOfferHandler,
  });

  fastify.post('/customer/offers/:offerId/confirm-payment', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: confirmOfferPaymentHandler,
  });

  // ── Jobs ──

  fastify.get('/customer/jobs', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: listCustomerJobsHandler,
  });

  fastify.get('/customer/jobs/:jobId', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: getCustomerJobHandler,
  });

  fastify.post('/customer/jobs/:jobId/confirm', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    handler: confirmJobHandler,
  });

  fastify.post('/customer/jobs/:jobId/update-payment', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    handler: updatePaymentMethodHandler,
  });

  // ── Map / Nearby Shops ──

  fastify.get('/customer/nearby-shops', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: customerNearbyShopsHandler,
  });
};

export default customerRequestsRoutes;
