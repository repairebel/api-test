import { FastifyPluginAsync } from 'fastify';
import { requireApproved } from '../../plugins/require-approved.plugin.js';
import {
  customerConfirmHandler,
  earningsSummaryHandler,
  listPayoutsHandler,
  cashoutHandler,
  refreshPayoutsHandler,
} from './earnings.controller.js';

const earningsRoutes: FastifyPluginAsync = async (fastify) => {
  // Legacy customer confirmation endpoint. Authentication and ownership are
  // still required even though the current app uses /customer/jobs/:jobId/confirm.
  fastify.post('/jobs/:jobId/customer-confirm', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: customerConfirmHandler,
  });

  // ── Earnings summary ──
  fastify.get('/shops/me/earnings/summary', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: earningsSummaryHandler,
  });

  // ── List payouts ──
  fastify.get('/shops/me/payouts', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: listPayoutsHandler,
  });

  // ── Cashout — transfer from Stripe Connect balance to bank ──
  fastify.post('/shops/me/cashout', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    handler: cashoutHandler,
  });

  // ── Refresh PROCESSING payout statuses from Stripe ──
  fastify.post('/shops/me/payouts/refresh', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: refreshPayoutsHandler,
  });
};

export default earningsRoutes;
