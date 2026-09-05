import { FastifyPluginAsync } from 'fastify';
import { requireApproved } from '../../plugins/require-approved.plugin.js';
import { requireUserType } from '../../plugins/auth.plugin.js';
import {
  listChatsHandler,
  getMessagesHandler,
  sendMessageHandler,
  markSeenHandler,
  customerListChatsHandler,
  customerGetMessagesHandler,
  customerSendMessageHandler,
  customerMarkSeenHandler,
  customerChatMediaSignatureHandler,
} from './chat.controller.js';

const chatRoutes: FastifyPluginAsync = async (fastify) => {
  // ═══════════ SHOP CHAT ENDPOINTS ═══════════

  // ── List chat threads ──
  fastify.get('/chats', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: listChatsHandler,
  });

  // ── Get messages for a job thread ──
  fastify.get('/chats/:jobId/messages', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: getMessagesHandler,
  });

  // ── Send a message ──
  fastify.post('/chats/:jobId/messages', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: sendMessageHandler,
  });

  // ── Mark messages as seen ──
  fastify.post('/chats/:jobId/seen', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: markSeenHandler,
  });

  // ═══════════ CUSTOMER CHAT ENDPOINTS ═══════════

  fastify.get('/customer/chats', {
    preHandler: [fastify.authenticate, requireUserType('CUSTOMER')],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: customerListChatsHandler,
  });

  fastify.get('/customer/chats/:jobId/messages', {
    preHandler: [fastify.authenticate, requireUserType('CUSTOMER')],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: customerGetMessagesHandler,
  });

  fastify.post('/customer/chats/:jobId/messages', {
    preHandler: [fastify.authenticate, requireUserType('CUSTOMER')],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: customerSendMessageHandler,
  });

  fastify.post('/customer/chats/:jobId/seen', {
    preHandler: [fastify.authenticate, requireUserType('CUSTOMER')],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: customerMarkSeenHandler,
  });

  // ── Cloudinary signature for customer chat media ──
  fastify.post('/customer/chats/:jobId/media-signature', {
    preHandler: [fastify.authenticate, requireUserType('CUSTOMER')],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: customerChatMediaSignatureHandler,
  });
};

export default chatRoutes;
