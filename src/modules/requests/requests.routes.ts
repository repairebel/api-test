import { FastifyPluginAsync } from 'fastify';
import { requireApproved } from '../../plugins/require-approved.plugin.js';
import { env } from '../../config/env.js';
import {
  listRequestsHandler,
  getRequestHandler,
  markSeenHandler,
  createOfferHandler,
  createTestRequestHandler,
  customerAcceptOfferHandler,
  nearbyShopsHandler,
  requestOffersHandler,
  requestStatusHandler,
} from './requests.controller.js';

const requestsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Requests feed ──

  fastify.get('/shops/me/requests', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: listRequestsHandler,
  });

  // ── Single request detail ──

  fastify.get('/requests/:requestId', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: getRequestHandler,
  });

  // ── Mark dispatch as seen ──

  fastify.post('/dispatch/:dispatchId/seen', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: markSeenHandler,
  });

  // ── Create offer ──

  fastify.post('/requests/:requestId/offers', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: createOfferHandler,
  });

  // ── [TEST] Create a request (simulates customer) — no auth ──
  if (env.NODE_ENV === 'production') return;

  fastify.post('/test/create-request', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: createTestRequestHandler,
  });

  // ── [TEST] Customer accepts an offer — no auth ──

  fastify.post('/test/accept-offer', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: customerAcceptOfferHandler,
  });

  // ── [TEST] Find nearby shops ──
  fastify.get('/test/nearby-shops', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: nearbyShopsHandler,
  });

  // ── [TEST] Get offers for a request ──
  fastify.get('/test/requests/:requestId/offers', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: requestOffersHandler,
  });

  // ── [TEST] Get request status + job info ──
  fastify.get('/test/requests/:requestId', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: requestStatusHandler,
  });
};

export default requestsRoutes;
