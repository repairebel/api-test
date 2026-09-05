import { FastifyRequest, FastifyReply } from 'fastify';
import {
  startStripeConnectBodySchema,
  updateWarrantyBodySchema,
  updateVacationBodySchema,
  updateNotificationsBodySchema,
  updateLocationExtBodySchema,
} from './settings.schema.js';
import * as settingsService from './settings.service.js';
import { successResponse } from '../../plugins/error-handler.plugin.js';

// ── GET /v1/shops/me/profile ──

export async function getShopProfileHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await settingsService.getShopProfile(request.user!.shopId);
  return reply.send(successResponse(result));
}

// ── PATCH /v1/shops/me/warranty ──

export async function updateWarrantyHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = updateWarrantyBodySchema.parse(request.body);
  const result = await settingsService.updateWarranty(request.user!.shopId, body);
  return reply.send(successResponse(result));
}

// ── PATCH /v1/shops/me/vacation ──

export async function updateVacationHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = updateVacationBodySchema.parse(request.body);
  const result = await settingsService.updateVacation(request.user!.shopId, body);
  return reply.send(successResponse(result));
}

// ── PATCH /v1/shops/me/notifications ──

export async function updateNotificationsHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = updateNotificationsBodySchema.parse(request.body);
  const result = await settingsService.updateNotifications(request.user!.shopId, body);
  return reply.send(successResponse(result));
}

// ── PATCH /v1/shops/me/location-ext ──

export async function updateLocationExtHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = updateLocationExtBodySchema.parse(request.body);
  const result = await settingsService.updateLocationExt(request.user!.shopId, body);
  return reply.send(successResponse(result));
}

// ── POST /v1/stripe/connect/start ──

export async function startStripeConnectHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = startStripeConnectBodySchema.parse(request.body ?? {});
  const result = await settingsService.startStripeConnect(request.user!.shopId, body);
  return reply.send(successResponse(result));
}

// ── GET /v1/stripe/connect/status ──

export async function getStripeStatusHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await settingsService.getStripeStatus(request.user!.shopId);
  return reply.send(successResponse(result));
}

// ── GET /v1/shops/me/tax-documents ──

export async function getShopTaxDocumentsHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await settingsService.getShopTaxDocuments(request.user!.shopId);
  return reply.send(successResponse(result));
}

// ── POST /v1/shops/me/tax-documents/access-link ──

export async function createShopTaxDocumentsAccessLinkHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const result = await settingsService.createShopTaxDocumentsAccessLink(request.user!.shopId);
  return reply.send(successResponse(result));
}

// ── POST /v1/stripe/connect/disconnect ──

export async function disconnectStripeHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await settingsService.disconnectStripe(request.user!.shopId);
  return reply.send(successResponse(result));
}

// ── PATCH /v1/shops/me/protection-enabled ──

export async function updateProtectionEnabledHandler(request: FastifyRequest, reply: FastifyReply) {
  const { enabled } = request.body as { enabled: boolean };
  const result = await settingsService.updateProtectionEnabled(request.user!.shopId, enabled);
  return reply.send(successResponse(result));
}
