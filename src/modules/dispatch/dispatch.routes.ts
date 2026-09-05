import { FastifyPluginAsync } from 'fastify';
import { requireApproved } from '../../plugins/require-approved.plugin.js';
import {
  startDispatchHandler,
  acceptDispatchHandler,
  declineDispatchHandler,
} from './dispatch.controller.js';

const dispatchRoutes: FastifyPluginAsync = async (fastify) => {
  // ── [TEST] Start dispatch (simulates customer creating request) ──
  fastify.post('/dispatch/start', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: startDispatchHandler,
  });

  // ── Accept dispatch ──
  fastify.post('/dispatch/:dispatchId/accept', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: acceptDispatchHandler,
  });

  // ── Decline dispatch ──
  fastify.post('/dispatch/:dispatchId/decline', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: declineDispatchHandler,
  });
};

export default dispatchRoutes;
