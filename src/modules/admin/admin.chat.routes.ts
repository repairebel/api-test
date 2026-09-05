import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import {
  listChats,
  getChatMessages,
  sendAdminMessage,
} from './admin.chat.service.js';

const chatRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/chats', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listChats({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      });
      return reply.send(paginatedResponse(result.data as any[], result.pagination));
    },
  });

  fastify.get('/admin/chats/:jobId/messages', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      const q = req.query as any;
      const result = await getChatMessages(jobId, {
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  fastify.post('/admin/chats/:jobId/messages', {
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      const { text } = req.body as { text: string };
      const msg = await sendAdminMessage(jobId, req.user!.userId, text);
      await logAudit(req.user!.userId, `Sent admin message in chat for job ${jobId}`, 'order', jobId);
      return reply.status(201).send(successResponse(msg));
    },
  });
};

export default chatRoutes;
