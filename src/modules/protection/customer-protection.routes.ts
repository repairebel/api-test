import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse } from '../../plugins/error-handler.plugin.js';
import {
  listAvailablePlans,
  subscribeToPlan,
  confirmSubscriptionPayment,
  getMySubscriptions,
  toggleAutopay,
  cancelMySubscription,
  submitClaim,
  getMyClaims,
} from './customer-protection.service.js';
import { db } from '../../db/client.js';
import { users } from '../../db/schema/index.js';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

const customerProtectionRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('CUSTOMER')];

  // ── List available protection plans ──
  fastify.get('/customer/protection/plans', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { shopId } = z.object({ shopId: z.string().uuid().optional() }).parse(req.query);
      const plans = await listAvailablePlans(req.user!.userId, shopId);
      return reply.send(successResponse(plans));
    },
  });

  // ── Subscribe to a plan ──
  fastify.post('/customer/protection/subscribe', {
    preHandler: auth,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { planId } = req.body as { planId: string };
      const customerId = req.user!.userId;

      // Get customer name
      const [user] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, customerId)).limit(1);
      const customerName = user?.fullName || 'Customer';

      const subscription = await subscribeToPlan(customerId, { planId, customerName });
      return reply.status(201).send(successResponse(subscription));
    },
  });

  // ── Confirm subscription payment (after 3DS) ──
  fastify.post('/customer/protection/subscriptions/:id/confirm-payment', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await confirmSubscriptionPayment(req.user!.userId, id);
      return reply.send(successResponse(result));
    },
  });

  // ── My subscriptions ──
  fastify.get('/customer/protection/subscriptions', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const subscriptions = await getMySubscriptions(req.user!.userId);
      return reply.send(successResponse(subscriptions));
    },
  });

  // ── Toggle autopay ──
  fastify.patch('/customer/protection/subscriptions/:id/autopay', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const { enabled } = req.body as { enabled: boolean };
      const result = await toggleAutopay(req.user!.userId, id, enabled);
      return reply.send(successResponse(result));
    },
  });

  // ── Cancel subscription ──
  fastify.post('/customer/protection/subscriptions/:id/cancel', {
    preHandler: auth,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await cancelMySubscription(req.user!.userId, id);
      return reply.send(successResponse(result));
    },
  });

  // ── Submit claim ──
  fastify.post('/customer/protection/claims', {
    preHandler: auth,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = req.body as {
        subscriptionId: string;
        deviceModel: string;
        reason: string;
        evidenceUrls?: string[];
        urgency?: 'LOW' | 'MEDIUM' | 'HIGH';
        jobId?: string;
      };
      const customerId = req.user!.userId;

      // Get customer name
      const [user] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, customerId)).limit(1);
      const customerName = user?.fullName || 'Customer';

      const claim = await submitClaim(customerId, customerName, body);
      return reply.status(201).send(successResponse(claim));
    },
  });

  // ── My claims ──
  fastify.get('/customer/protection/claims', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const claims = await getMyClaims(req.user!.userId);
      return reply.send(successResponse(claims));
    },
  });
};

export default customerProtectionRoutes;
