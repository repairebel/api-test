import { FastifyRequest, FastifyReply } from 'fastify';
import {
  listChatThreads,
  getMessages,
  sendMessage,
  markSeen,
  listCustomerChatThreads,
  getCustomerMessages,
  sendCustomerMessage,
  markCustomerSeen,
} from './chat.service.js';
import { successResponse, AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { generateCloudinarySignature } from '../media/media.service.js';

// ════════════════════════════════════════════════
// SHOP HANDLERS (existing)
// ════════════════════════════════════════════════

// GET /v1/chats
export async function listChatsHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const threads = await listChatThreads(shopId);
  return reply.send(successResponse(threads));
}

// GET /v1/chats/:jobId/messages?before=&limit=30
export async function getMessagesHandler(request: FastifyRequest, reply: FastifyReply) {
  const { jobId } = request.params as { jobId: string };
  const shopId = request.user!.shopId;
  const { before, limit = '30' } = request.query as { before?: string; limit?: string };

  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const result = await getMessages(jobId, shopId, before, lim);
  return reply.send(successResponse(result));
}

// POST /v1/chats/:jobId/messages
export async function sendMessageHandler(request: FastifyRequest, reply: FastifyReply) {
  const { jobId } = request.params as { jobId: string };
  const shopId = request.user!.shopId;
  const userId = request.user!.userId;

  const { clientMessageId, type, text, mediaUrl, publicId, thumbUrl, durationMs } =
    request.body as {
      clientMessageId: string;
      type: 'TEXT' | 'IMAGE' | 'VIDEO';
      text?: string;
      mediaUrl?: string;
      publicId?: string;
      thumbUrl?: string;
      durationMs?: number;
    };

  if (!clientMessageId || !type) {
    return reply.code(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'clientMessageId and type are required' },
    });
  }

  const result = await sendMessage(
    {
      jobId,
      senderId: userId,
      senderRole: 'SHOP',
      clientMessageId,
      type,
      text,
      mediaUrl,
      publicId,
      thumbUrl,
      durationMs,
    },
    shopId,
  );

  return reply.code(result.duplicate ? 200 : 201).send(successResponse(result));
}

// POST /v1/chats/:jobId/seen
export async function markSeenHandler(request: FastifyRequest, reply: FastifyReply) {
  const { jobId } = request.params as { jobId: string };
  const shopId = request.user!.shopId;
  const { lastSeenMessageId } = request.body as { lastSeenMessageId: string };

  if (!lastSeenMessageId) {
    return reply.code(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'lastSeenMessageId is required' },
    });
  }

  const result = await markSeen(jobId, shopId, lastSeenMessageId);
  return reply.send(successResponse(result));
}

// ════════════════════════════════════════════════
// CUSTOMER HANDLERS
// ════════════════════════════════════════════════

// GET /v1/customer/chats
export async function customerListChatsHandler(request: FastifyRequest, reply: FastifyReply) {
  const customerId = request.user!.userId;
  const threads = await listCustomerChatThreads(customerId);
  return reply.send(successResponse(threads));
}

// GET /v1/customer/chats/:jobId/messages?before=&limit=30
export async function customerGetMessagesHandler(request: FastifyRequest, reply: FastifyReply) {
  const { jobId } = request.params as { jobId: string };
  const customerId = request.user!.userId;
  const { before, limit = '30' } = request.query as { before?: string; limit?: string };

  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const result = await getCustomerMessages(jobId, customerId, before, lim);
  return reply.send(successResponse(result));
}

// POST /v1/customer/chats/:jobId/messages
export async function customerSendMessageHandler(request: FastifyRequest, reply: FastifyReply) {
  const { jobId } = request.params as { jobId: string };
  const customerId = request.user!.userId;

  const { clientMessageId, type, text, mediaUrl, publicId, thumbUrl, durationMs } =
    request.body as {
      clientMessageId: string;
      type: 'TEXT' | 'IMAGE' | 'VIDEO';
      text?: string;
      mediaUrl?: string;
      publicId?: string;
      thumbUrl?: string;
      durationMs?: number;
    };

  if (!clientMessageId || !type) {
    return reply.code(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'clientMessageId and type are required' },
    });
  }

  const result = await sendCustomerMessage(
    {
      jobId,
      senderId: customerId,
      clientMessageId,
      type,
      text,
      mediaUrl,
      publicId,
      thumbUrl,
      durationMs,
    },
    customerId,
  );

  return reply.code(result.duplicate ? 200 : 201).send(successResponse(result));
}

// POST /v1/customer/chats/:jobId/seen
export async function customerMarkSeenHandler(request: FastifyRequest, reply: FastifyReply) {
  const { jobId } = request.params as { jobId: string };
  const customerId = request.user!.userId;
  const { lastSeenMessageId } = request.body as { lastSeenMessageId: string };

  if (!lastSeenMessageId) {
    return reply.code(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'lastSeenMessageId is required' },
    });
  }

  const result = await markCustomerSeen(jobId, customerId, lastSeenMessageId);
  return reply.send(successResponse(result));
}

// POST /v1/customer/chats/:jobId/media-signature
export async function customerChatMediaSignatureHandler(request: FastifyRequest, reply: FastifyReply) {
  const { jobId } = request.params as { jobId: string };
  const { resourceType = 'image' } = (request.body || {}) as { resourceType?: 'image' | 'video' };

  if (!['image', 'video'].includes(resourceType)) {
    return reply.code(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'resourceType must be image or video' },
    });
  }

  const result = generateCloudinarySignature({
    context: 'CHAT',
    entityId: jobId,
    resourceType,
  });
  return reply.send(successResponse(result));
}
