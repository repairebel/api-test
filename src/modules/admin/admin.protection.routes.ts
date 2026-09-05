import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import {
  listPlans,
  listSubscribers,
  listClaims,
  approveClaim,
  denyClaim,
  adminCancelSubscription,
  adminRefundSubscription,
  adminToggleAutopay,
} from './admin.protection.service.js';

const protectionRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/protection/plans', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listPlans({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        shopId: q.shopId,
        status: q.status,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  fastify.get('/admin/protection/subscribers', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listSubscribers({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        planId: q.planId,
        status: q.status,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  fastify.get('/admin/protection/claims', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listClaims({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        status: q.status,
        urgency: q.urgency,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  fastify.post('/admin/protection/claims/:id/approve', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const { payoutAmountCents, decisionNotes } = req.body as { payoutAmountCents: number; decisionNotes?: string };
      const result = await approveClaim(id, payoutAmountCents, decisionNotes);
      await logAudit(req.user!.userId, `Approved protection claim ${id}`, 'finance', id);
      return reply.send(successResponse(result));
    },
  });

  fastify.post('/admin/protection/claims/:id/deny', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const { decisionNotes } = req.body as { decisionNotes?: string };
      const result = await denyClaim(id, decisionNotes);
      await logAudit(req.user!.userId, `Denied protection claim ${id}`, 'finance', id);
      return reply.send(successResponse(result));
    },
  });

  // ─── Subscription Management ───

  fastify.post('/admin/protection/subscribers/:id/cancel', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await adminCancelSubscription(id);
      try {
        await logAudit(req.user!.userId, `Canceled protection subscription ${id}`, 'finance', id);
      } catch (auditErr: any) {
        req.log.error({ err: auditErr }, 'Failed to write audit log for cancel');
      }
      return reply.send(successResponse(result));
    },
  });

  fastify.post('/admin/protection/subscribers/:id/refund', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const { amountCents } = (req.body as { amountCents?: number }) ?? {};
      const result = await adminRefundSubscription(id, amountCents);
      try {
        await logAudit(req.user!.userId, `Refunded protection subscription ${id} — $${(result.refundAmountCents / 100).toFixed(2)}`, 'finance', id);
      } catch (auditErr: any) {
        req.log.error({ err: auditErr }, 'Failed to write audit log for refund');
      }
      return reply.send(successResponse(result));
    },
  });

  fastify.patch('/admin/protection/subscribers/:id/autopay', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const { enabled } = req.body as { enabled: boolean };
      const result = await adminToggleAutopay(id, enabled);
      await logAudit(req.user!.userId, `Toggled autopay ${enabled ? 'ON' : 'OFF'} for subscription ${id}`, 'finance', id);
      return reply.send(successResponse(result));
    },
  });
};

export default protectionRoutes;
