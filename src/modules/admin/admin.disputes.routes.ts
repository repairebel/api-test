import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import {
  listDisputes,
  getDisputeById,
  getDisputeMessages,
  sendDisputeMessage,
  resolveDisputeRefund,
  closeDispute,
  rejectDispute,
  updateDisputeStatus,
} from './admin.disputes.service.js';

const disputesRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/disputes', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listDisputes({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        search: q.search,
        status: q.status,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  fastify.get('/admin/disputes/:id', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const dispute = await getDisputeById(id);
      return reply.send(successResponse(dispute));
    },
  });

  fastify.get('/admin/disputes/:id/messages', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const messages = await getDisputeMessages(id);
      return reply.send(successResponse(messages));
    },
  });

  fastify.post('/admin/disputes/:id/messages', {
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const { message } = req.body as { message: string };
      const msg = await sendDisputeMessage(id, req.user!.userId, message);
      await logAudit(req.user!.userId, `Sent message in dispute ${id}`, 'dispute', id);
      return reply.status(201).send(successResponse(msg));
    },
  });

  fastify.post('/admin/disputes/:id/refund', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body as any) ?? {};
      const result = await resolveDisputeRefund(id, {
        type: body.type ?? 'full',
        amountCents: body.amountCents ? Number(body.amountCents) : undefined,
      });
      await logAudit(req.user!.userId, `Resolved dispute ${id} with refund`, 'dispute', id);
      return reply.send(successResponse(result));
    },
  });

  fastify.post('/admin/disputes/:id/close', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await closeDispute(id);
      await logAudit(req.user!.userId, `Closed dispute ${id}`, 'dispute', id);
      return reply.send(successResponse(result));
    },
  });

  fastify.post('/admin/disputes/:id/reject', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await rejectDispute(id);
      await logAudit(req.user!.userId, `Rejected dispute ${id}`, 'dispute', id);
      return reply.send(successResponse(result));
    },
  });

  fastify.post('/admin/disputes/:id/status', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const { status } = req.body as { status: 'IN_PROGRESS' | 'UNDER_REVIEW' | 'FINALIZING' };
      
      if (!['IN_PROGRESS', 'UNDER_REVIEW', 'FINALIZING'].includes(status)) {
        return reply.code(400).send({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid status' },
        });
      }

      const result = await updateDisputeStatus(id, status);
      await logAudit(req.user!.userId, `Updated dispute ${id} status to ${status}`, 'dispute', id);
      return reply.send(successResponse(result));
    },
  });
};

export default disputesRoutes;
