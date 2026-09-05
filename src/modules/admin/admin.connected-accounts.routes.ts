import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import {
  listConnectedAccounts,
  getConnectedAccountDetail,
  freezeConnectedAccount,
  unfreezeConnectedAccount,
  syncConnectedAccountStatus,
} from './admin.connected-accounts.service.js';

const connectedAccountsRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  // List all connected accounts with Stripe info
  fastify.get('/admin/connected-accounts', {
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listConnectedAccounts(
        q.page ? Number(q.page) : 1,
        q.limit ? Number(q.limit) : 20,
        q.search,
        q.status,
      );
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  // Get detailed Stripe info for a single connected account
  fastify.get('/admin/connected-accounts/:shopId', {
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { shopId } = req.params as { shopId: string };
      const detail = await getConnectedAccountDetail(shopId);
      return reply.send(successResponse(detail));
    },
  });

  // Freeze payouts (set to manual schedule)
  fastify.post('/admin/connected-accounts/:shopId/freeze', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { shopId } = req.params as { shopId: string };
      const { reason } = (req.body as { reason?: string }) ?? {};
      const result = await freezeConnectedAccount(shopId, req.user!.userId, reason ?? '');
      await logAudit(req.user!.userId, `Froze payouts for shop ${shopId}: ${reason}`, 'finance', shopId);
      return reply.send(successResponse(result));
    },
  });

  // Unfreeze payouts (resume daily schedule)
  fastify.post('/admin/connected-accounts/:shopId/unfreeze', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { shopId } = req.params as { shopId: string };
      const result = await unfreezeConnectedAccount(shopId);
      await logAudit(req.user!.userId, `Unfroze payouts for shop ${shopId}`, 'finance', shopId);
      return reply.send(successResponse(result));
    },
  });

  // Sync account status from Stripe
  fastify.post('/admin/connected-accounts/:shopId/sync', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { shopId } = req.params as { shopId: string };
      const result = await syncConnectedAccountStatus(shopId);
      await logAudit(req.user!.userId, `Synced Stripe status for shop ${shopId}`, 'finance', shopId);
      return reply.send(successResponse(result));
    },
  });
};

export default connectedAccountsRoutes;
