import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import {
  listSupportTickets,
  getSupportConversation,
  replySupportMessage,
  toggleAgentAvailability,
  getAgentStatus,
  getAvailableAgentsCount,
  getAvailableAgents,
  listWaitingConversations,
  acceptConversation,
  sendSupportMessage,
  updateTicketStatus,
  transferConversation,
  closeConversation,
} from './admin.support.service.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';

const supportRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  // ── Agent Availability ──
  fastify.post('/admin/support/agent-status', {
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { isAvailable } = req.body as { isAvailable: boolean };
      // Get the admin user record for this user
      const adminUserId = await getAdminUserId(req.user!.userId);
      const result = await toggleAgentAvailability(adminUserId, isAvailable);
      return reply.send(successResponse(result));
    },
  });

  fastify.get('/admin/support/agent-status', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const adminUserId = await getAdminUserId(req.user!.userId);
      const result = await getAgentStatus(adminUserId);
      return reply.send(successResponse(result));
    },
  });

  fastify.get('/admin/support/available-agents', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const agents = await getAvailableAgents();
      return reply.send(successResponse(agents));
    },
  });

  // ── Waiting Queue ──
  fastify.get('/admin/support/waiting', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const conversations = await listWaitingConversations();
      return reply.send(successResponse(conversations));
    },
  });

  // ── Accept Conversation ──
  fastify.post('/admin/support/:id/accept', {
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const adminUserId = await getAdminUserId(req.user!.userId);
      const result = await acceptConversation(id, adminUserId);
      await logAudit(req.user!.userId, `Accepted support conversation ${id}`, 'user', id);
      return reply.send(successResponse(result));
    },
  });

  // ── Send Message ──
  fastify.post('/admin/support/:id/message', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const { content } = req.body as { content: string };
      if (!content?.trim()) {
        throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Message content is required');
      }
      const adminUserId = await getAdminUserId(req.user!.userId);
      const msg = await sendSupportMessage(id, adminUserId, 'assistant', content);
      return reply.status(201).send(successResponse(msg));
    },
  });

  // ── Ticket Status ──
  fastify.patch('/admin/support/:id/ticket', {
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const { ticketStatus } = req.body as { ticketStatus: 'open' | 'in_review' | 'closed' };
      const result = await updateTicketStatus(id, ticketStatus);
      await logAudit(req.user!.userId, `Updated support ticket ${id} status to ${ticketStatus}`, 'user', id);
      return reply.send(successResponse(result));
    },
  });

  // ── Transfer ──
  fastify.post('/admin/support/:id/transfer', {
    preHandler: auth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const { toAgentId } = req.body as { toAgentId: string };
      const adminUserId = await getAdminUserId(req.user!.userId);
      const result = await transferConversation(id, adminUserId, toAgentId);
      await logAudit(req.user!.userId, `Transferred support conversation ${id}`, 'user', id);
      return reply.send(successResponse(result));
    },
  });

  // ── Close Conversation ──
  fastify.post('/admin/support/:id/close', {
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const adminUserId = await getAdminUserId(req.user!.userId);
      const result = await closeConversation(id, adminUserId);
      await logAudit(req.user!.userId, `Closed support conversation ${id}`, 'user', id);
      return reply.send(successResponse(result));
    },
  });

  // ── List All Support Tickets ──
  fastify.get('/admin/support', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listSupportTickets({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        status: q.status || undefined,
        ticketStatus: q.ticketStatus || undefined,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  // ── Get Conversation Detail ──
  fastify.get('/admin/support/:id', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const conversation = await getSupportConversation(id);
      return reply.send(successResponse(conversation));
    },
  });

  // ── Legacy Reply (kept for backward compat) ──
  fastify.post('/admin/support/:id/reply', {
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const { content } = req.body as { content: string };
      const adminUserId = await getAdminUserIdSafe(req.user!.userId);
      const msg = await replySupportMessage(id, content, adminUserId ?? undefined);
      await logAudit(req.user!.userId, `Replied to support ticket ${id}`, 'user', id);
      return reply.status(201).send(successResponse(msg));
    },
  });
};

// ── Helper: get admin_users.id from users.id ──
import { db } from '../../db/client.js';
import { adminUsers } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';

async function getAdminUserId(userId: string): Promise<string> {
  const [admin] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.userId, userId))
    .limit(1);

  if (!admin) throw new AppError(403, ErrorCode.FORBIDDEN, 'Not an admin user');
  return admin.id;
}

async function getAdminUserIdSafe(userId: string): Promise<string | null> {
  const [admin] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.userId, userId))
    .limit(1);

  return admin?.id ?? null;
}

export default supportRoutes;
