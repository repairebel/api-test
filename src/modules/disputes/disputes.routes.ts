import { FastifyPluginAsync } from 'fastify';
import { requireApproved } from '../../plugins/require-approved.plugin.js';
import { requireUserType } from '../../plugins/auth.plugin.js';
import {
  shopListDisputesHandler,
  shopGetDisputeDetailHandler,
  shopRespondHandler,
  shopEvidenceSignatureHandler,
  customerCreateDisputeHandler,
  customerListDisputesHandler,
  customerGetDisputeDetailHandler,
  customerRespondHandler,
  customerEvidenceSignatureHandler,
  customerVideoSignatureHandler,
} from './disputes.controller.js';

const disputesRoutes: FastifyPluginAsync = async (fastify) => {
  // ═══════════ SHOP DISPUTE ENDPOINTS ═══════════

  // ── List disputes for shop ──
  fastify.get('/shops/me/disputes', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: shopListDisputesHandler,
  });

  // ── Get dispute detail (shop) ──
  fastify.get('/disputes/:disputeId', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: shopGetDisputeDetailHandler,
  });

  // ── Respond to dispute (shop) ──
  fastify.post('/disputes/:disputeId/respond', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: shopRespondHandler,
  });

  // ── Evidence upload signature (shop) ──
  fastify.post('/disputes/:disputeId/evidence-signature', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: shopEvidenceSignatureHandler,
  });

  // ═══════════ CUSTOMER DISPUTE ENDPOINTS ═══════════

  // ── Create a dispute ──
  fastify.post('/jobs/:jobId/disputes', {
    preHandler: [fastify.authenticate, requireUserType('CUSTOMER')],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: customerCreateDisputeHandler,
  });

  // ── List customer disputes ──
  fastify.get('/customer/disputes', {
    preHandler: [fastify.authenticate, requireUserType('CUSTOMER')],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: customerListDisputesHandler,
  });

  // ── Get dispute detail (customer) ──
  fastify.get('/customer/disputes/:disputeId', {
    preHandler: [fastify.authenticate, requireUserType('CUSTOMER')],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: customerGetDisputeDetailHandler,
  });

  // ── Respond to dispute (customer) ──
  fastify.post('/customer/disputes/:disputeId/respond', {
    preHandler: [fastify.authenticate, requireUserType('CUSTOMER')],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: customerRespondHandler,
  });

  // ── Pre-dispute video upload signature (customer, before dispute exists) ──
  fastify.post('/customer/disputes/video-signature', {
    preHandler: [fastify.authenticate, requireUserType('CUSTOMER')],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: customerVideoSignatureHandler,
  });

  // ── Evidence upload signature (customer) ──
  fastify.post('/customer/disputes/:disputeId/evidence-signature', {
    preHandler: [fastify.authenticate, requireUserType('CUSTOMER')],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: customerEvidenceSignatureHandler,
  });
};

export default disputesRoutes;
