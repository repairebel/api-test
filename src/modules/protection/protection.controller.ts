import { FastifyRequest, FastifyReply } from 'fastify';
import {
  createPlan,
  listPlans,
  getPlanById,
  updatePlan,
  listSubscribers,
  cancelSubscription,
  listClaims,
  getClaimById,
  reviewClaim,
  getProtectionAnalytics,
} from './protection.service.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';

// ─── Plans ───

export async function listPlansHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const plans = await listPlans(shopId);
  return reply.send(successResponse(plans));
}

export async function createPlanHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const body = request.body as {
    name: string;
    billingType: 'ONE_TIME' | 'MONTHLY';
    priceCents: number;
    coverageDays?: number;
    coveredPartTypes: string[];
    maxClaimsPerPeriod?: number;
    maxPayoutPerClaimCents: number;
    deductibleCents?: number;
    termsText?: string;
    exclusionsText?: string;
    status?: 'ACTIVE' | 'PAUSED';
  };

  const plan = await createPlan(shopId, {
    name: body.name,
    billingType: body.billingType,
    priceCents: body.priceCents,
    coverageDays: body.coverageDays ?? 0,
    coveredPartTypes: body.coveredPartTypes,
    maxClaimsPerPeriod: body.maxClaimsPerPeriod ?? 1,
    maxPayoutPerClaimCents: body.maxPayoutPerClaimCents,
    deductibleCents: body.deductibleCents ?? 0,
    termsText: body.termsText,
    exclusionsText: body.exclusionsText,
    status: body.status ?? 'ACTIVE',
  });

  return reply.status(201).send(successResponse(plan));
}

export async function getPlanHandler(request: FastifyRequest, reply: FastifyReply) {
  const { planId } = request.params as { planId: string };
  const plan = await getPlanById(planId);
  return reply.send(successResponse(plan));
}

export async function updatePlanHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const { planId } = request.params as { planId: string };
  const body = request.body as Record<string, any>;

  const updated = await updatePlan(planId, shopId, body);
  return reply.send(successResponse(updated));
}

// ─── Subscribers ───

export async function listSubscribersHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const { planId } = request.params as { planId: string };
  const { page = '1', pageSize = '20', status: statusFilter } = request.query as Record<string, string>;

  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(50, Math.max(1, parseInt(pageSize, 10) || 20));

  const { data, total } = await listSubscribers(planId, shopId, p, ps, statusFilter);
  return reply.send(paginatedResponse(data, { page: p, pageSize: ps, total }));
}

export async function cancelSubscriptionHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const { subscriptionId } = request.params as { subscriptionId: string };

  const result = await cancelSubscription(subscriptionId, shopId);
  return reply.send(successResponse(result));
}

// ─── Claims ───

export async function listClaimsHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const { page = '1', pageSize = '20', status: statusFilter } = request.query as Record<string, string>;

  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(50, Math.max(1, parseInt(pageSize, 10) || 20));

  const { data, total } = await listClaims(shopId, p, ps, statusFilter);
  return reply.send(paginatedResponse(data, { page: p, pageSize: ps, total }));
}

export async function getClaimHandler(request: FastifyRequest, reply: FastifyReply) {
  const { claimId } = request.params as { claimId: string };
  const claim = await getClaimById(claimId);
  return reply.send(successResponse(claim));
}

export async function reviewClaimHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const { claimId } = request.params as { claimId: string };
  const body = request.body as {
    decision: 'APPROVE' | 'DENY' | 'MORE_INFO';
    payoutAmountCents?: number;
    notes?: string;
  };

  const result = await reviewClaim(claimId, shopId, body);
  return reply.send(successResponse(result));
}

// ─── Analytics ───

export async function protectionAnalyticsHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const { range = '30d' } = request.query as { range?: string };
  const analytics = await getProtectionAnalytics(shopId, range);
  return reply.send(successResponse(analytics));
}
