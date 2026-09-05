import { FastifyRequest, FastifyReply } from 'fastify';
import {
  updateProfileBodySchema,
  changePasswordBodySchema,
  changeEmailBodySchema,
  createAddressBodySchema,
  updateAddressBodySchema,
  updateNotificationPrefsBodySchema,
  updatePrivacyBodySchema,
  deleteAccountBodySchema,
  confirmSetupBodySchema,
  confirmWithTokenBodySchema,
  supportChatBodySchema,
} from './customer-settings.schema.js';
import * as svc from './customer-settings.service.js';
import { successResponse, AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';

function requireCustomer(request: FastifyRequest) {
  const user = request.user!;
  if (user.userType !== 'CUSTOMER') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Only customers can access this endpoint');
  }
  return user;
}

// ── Profile ──

export async function updateProfileHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const body = updateProfileBodySchema.parse(request.body);
  const result = await svc.updateProfile(user.userId, body);
  return reply.send(successResponse(result));
}

export async function changePasswordHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const body = changePasswordBodySchema.parse(request.body);
  const result = await svc.changePassword(user.userId, body);
  return reply.send(successResponse(result));
}

export async function changeEmailHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const body = changeEmailBodySchema.parse(request.body);
  const result = await svc.changeEmail(user.userId, body.newEmail, body.password);
  return reply.send(successResponse(result));
}

export async function getStatsHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const result = await svc.getCustomerStats(user.userId);
  return reply.send(successResponse(result));
}

// ── Addresses ──

export async function listAddressesHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const result = await svc.listAddresses(user.userId);
  return reply.send(successResponse(result));
}

export async function createAddressHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const body = createAddressBodySchema.parse(request.body);
  const result = await svc.createAddress(user.userId, body);
  return reply.status(201).send(successResponse(result));
}

export async function updateAddressHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const { id } = request.params as { id: string };
  const body = updateAddressBodySchema.parse(request.body);
  const result = await svc.updateAddress(user.userId, id, body);
  return reply.send(successResponse(result));
}

export async function deleteAddressHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const { id } = request.params as { id: string };
  const result = await svc.deleteAddress(user.userId, id);
  return reply.send(successResponse(result));
}

// ── Payment Methods ──

export async function listPaymentMethodsHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const result = await svc.listPaymentMethods(user.userId);
  return reply.send(successResponse(result));
}

export async function createSetupIntentHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const result = await svc.createSetupIntent(user.userId);
  return reply.send(successResponse(result));
}

export async function confirmSetupHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const body = confirmSetupBodySchema.parse(request.body);
  const result = await svc.confirmSetupAndSave(user.userId, body.setupIntentId);
  return reply.send(successResponse(result));
}

export async function confirmSetupWithTokenHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const body = confirmWithTokenBodySchema.parse(request.body);
  const result = await svc.confirmSetupWithToken(user.userId, body.setupIntentId, body.cardToken);
  return reply.send(successResponse(result));
}

export async function deletePaymentMethodHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const { id } = request.params as { id: string };
  const result = await svc.deletePaymentMethod(user.userId, id);
  return reply.send(successResponse(result));
}

export async function setDefaultPaymentMethodHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const { id } = request.params as { id: string };
  const result = await svc.setDefaultPaymentMethod(user.userId, id);
  return reply.send(successResponse(result));
}

// ── Notification Preferences ──

export async function getNotificationPrefsHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const result = await svc.getNotificationPrefs(user.userId);
  return reply.send(successResponse(result));
}

export async function updateNotificationPrefsHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const body = updateNotificationPrefsBodySchema.parse(request.body);
  const result = await svc.updateNotificationPrefs(user.userId, body);
  return reply.send(successResponse(result));
}

// ── Privacy ──

export async function getPrivacySettingsHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const result = await svc.getPrivacySettings(user.userId);
  return reply.send(successResponse(result));
}

export async function updatePrivacySettingsHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const body = updatePrivacyBodySchema.parse(request.body);
  const result = await svc.updatePrivacySettings(user.userId, body);
  return reply.send(successResponse(result));
}

export async function deleteAccountHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const body = deleteAccountBodySchema.parse(request.body);
  const result = await svc.deleteAccount(user.userId, body.password);
  return reply.send(successResponse(result));
}

export async function exportDataHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const result = await svc.exportUserData(user.userId);
  return reply.send(successResponse(result));
}

// ── Support Chat ──

export async function chatHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const body = supportChatBodySchema.parse(request.body);
  const result = await svc.chatWithAI(user.userId, body);
  return reply.send(successResponse(result));
}

export async function listConversationsHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const result = await svc.listConversations(user.userId);
  return reply.send(successResponse(result));
}

export async function getChatHistoryHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const { id } = request.params as { id: string };
  const result = await svc.getChatHistory(user.userId, id);
  return reply.send(successResponse(result));
}

// ── Support: Connect to Agent ──

import {
  connectToAgent,
  checkAgentAvailable,
  sendSupportMessage,
  getSupportConversation as getSupportConvDetail,
  listCustomerConversations,
} from '../admin/admin.support.service.js';

export async function connectAgentHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const { category, description } = request.body as { category: string; description: string };
  if (!description?.trim()) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Description is required');
  }
  const result = await connectToAgent(user.userId, category || 'other', description);
  return reply.status(201).send(successResponse(result));
}

export async function checkAgentAvailableHandler(request: FastifyRequest, reply: FastifyReply) {
  requireCustomer(request);
  const result = await checkAgentAvailable();
  return reply.send(successResponse(result));
}

export async function sendCustomerSupportMessageHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const { id } = request.params as { id: string };
  const { content, type, mediaUrl } = request.body as { 
    content: string; 
    type?: 'text' | 'image' | 'video'; 
    mediaUrl?: string; 
  };
  
  if (!content?.trim() && !mediaUrl) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Message content or media is required');
  }
  const msgType = type && ['text', 'image', 'video'].includes(type) ? type : 'text';
  const msg = await sendSupportMessage(id, user.userId, 'user', content || '', msgType, mediaUrl);
  return reply.status(201).send(successResponse(msg));
}

export async function getCustomerSupportConversationHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const { id } = request.params as { id: string };
  const result = await getSupportConvDetail(id);
  // Verify the customer owns this conversation
  if (result.userId !== user.userId) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Not your conversation');
  }
  return reply.send(successResponse(result));
}

export async function listCustomerSupportConversationsHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireCustomer(request);
  const result = await listCustomerConversations(user.userId);
  return reply.send(successResponse(result));
}

