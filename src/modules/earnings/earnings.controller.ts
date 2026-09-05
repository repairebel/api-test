import { FastifyRequest, FastifyReply } from 'fastify';
import {
  customerConfirmJob,
  getEarningsSummary,
  listPayouts,
  cashout,
  refreshPayoutStatuses,
} from './earnings.service.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';

// POST /v1/jobs/:jobId/customer-confirm
export async function customerConfirmHandler(request: FastifyRequest, reply: FastifyReply) {
  const { jobId } = request.params as { jobId: string };
  const result = await customerConfirmJob(jobId);
  return reply.send(successResponse(result));
}

// GET /v1/shops/me/earnings/summary?range=7d|30d|90d
export async function earningsSummaryHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const { range = '30d' } = request.query as { range?: string };
  const summary = await getEarningsSummary(shopId, range);
  return reply.send(successResponse(summary));
}

// GET /v1/shops/me/payouts?page=1&pageSize=20
export async function listPayoutsHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const { page = '1', pageSize = '20' } = request.query as Record<string, string>;

  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(50, Math.max(1, parseInt(pageSize, 10) || 20));

  const { data, total } = await listPayouts(shopId, p, ps);
  return reply.send(paginatedResponse(data, { page: p, pageSize: ps, total }));
}

// POST /v1/shops/me/cashout
export async function cashoutHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const { amountCents, method = 'instant' } = request.body as {
    amountCents: number;
    method?: 'instant';
  };

  if (!amountCents || typeof amountCents !== 'number' || amountCents < 100) {
    return reply.status(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'amountCents must be at least 100 ($1.00)' },
    });
  }

  const result = await cashout(shopId, amountCents, method);
  return reply.send(successResponse(result));
}

// POST /v1/shops/me/payouts/refresh
export async function refreshPayoutsHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const result = await refreshPayoutStatuses(shopId);
  return reply.send(successResponse(result));
}
