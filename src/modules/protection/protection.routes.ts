import { FastifyPluginAsync } from 'fastify';
import { requireApproved } from '../../plugins/require-approved.plugin.js';
import {
  listPlansHandler,
  createPlanHandler,
  getPlanHandler,
  updatePlanHandler,
  listSubscribersHandler,
  cancelSubscriptionHandler,
  listClaimsHandler,
  getClaimHandler,
  reviewClaimHandler,
  protectionAnalyticsHandler,
} from './protection.controller.js';

const protectionRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireApproved];

  // ── Plans ──

  fastify.get('/shops/me/protection/plans', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: listPlansHandler,
  });

  fastify.post('/shops/me/protection/plans', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: createPlanHandler,
  });

  fastify.get('/protection/plans/:planId', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: getPlanHandler,
  });

  fastify.patch('/protection/plans/:planId', {
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: updatePlanHandler,
  });

  // ── Subscribers ──

  fastify.get('/protection/plans/:planId/subscribers', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: listSubscribersHandler,
  });

  fastify.post('/protection/subscribers/:subscriptionId/cancel', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: cancelSubscriptionHandler,
  });

  // ── Claims ──

  fastify.get('/shops/me/protection/claims', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: listClaimsHandler,
  });

  fastify.get('/protection/claims/:claimId', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: getClaimHandler,
  });

  fastify.post('/protection/claims/:claimId/review', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: reviewClaimHandler,
  });

  // ── Analytics ──

  fastify.get('/shops/me/protection/analytics', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: protectionAnalyticsHandler,
  });
};

export default protectionRoutes;
