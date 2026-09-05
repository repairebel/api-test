import { FastifyRequest, FastifyReply } from 'fastify';
import {
  updateShopBodySchema,
  updateLocationBodySchema,
  updateHoursBodySchema,
  updateServiceAreaBodySchema,
  submitOnboardingBodySchema,
  adminRejectBodySchema,
} from './onboarding.schema.js';
import * as onboardingService from './onboarding.service.js';
import { successResponse } from '../../plugins/error-handler.plugin.js';

// ── PATCH /v1/shops/me ──

export async function updateShopHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = updateShopBodySchema.parse(request.body);
  const result = await onboardingService.updateShop(request.user!.shopId, body);
  return reply.send(successResponse(result));
}

// ── PATCH /v1/shops/me/location ──

export async function updateLocationHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = updateLocationBodySchema.parse(request.body);
  const result = await onboardingService.updateLocation(request.user!.shopId, body);
  return reply.send(successResponse(result));
}

// ── PATCH /v1/shops/me/hours ──

export async function updateHoursHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = updateHoursBodySchema.parse(request.body);
  const result = await onboardingService.updateHours(request.user!.shopId, body);
  return reply.send(successResponse(result));
}

// ── PATCH /v1/shops/me/service-area ──

export async function updateServiceAreaHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = updateServiceAreaBodySchema.parse(request.body);
  const result = await onboardingService.updateServiceArea(request.user!.shopId, body);
  return reply.send(successResponse(result));
}

// ── POST /v1/onboarding/submit ──

export async function submitOnboardingHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = submitOnboardingBodySchema.parse(request.body);
  const result = await onboardingService.submitOnboarding(request.user!.shopId, body);
  return reply.status(201).send(successResponse(result));
}

// ── GET /v1/onboarding/status ──

export async function getOnboardingStatusHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await onboardingService.getOnboardingStatus(request.user!.shopId);
  return reply.send(successResponse(result));
}

// ── POST /v1/media/cloudinary/signature ──

export async function getCloudinarySignatureHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = onboardingService.getCloudinarySignature(request.user!.shopId);
  return reply.send(successResponse(result));
}

// ── POST /v1/admin/onboarding/:shopId/approve ──

export async function approveShopHandler(
  request: FastifyRequest<{ Params: { shopId: string } }>,
  reply: FastifyReply,
) {
  const result = await onboardingService.approveShop(request.params.shopId);
  return reply.send(successResponse(result));
}

// ── POST /v1/admin/onboarding/:shopId/reject ──

export async function rejectShopHandler(
  request: FastifyRequest<{ Params: { shopId: string } }>,
  reply: FastifyReply,
) {
  const { reason } = adminRejectBodySchema.parse(request.body);
  const result = await onboardingService.rejectShop(request.params.shopId, reason);
  return reply.send(successResponse(result));
}
