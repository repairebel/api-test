import { FastifyRequest, FastifyReply } from 'fastify';
import {
  signupBodySchema,
  signupCustomerBodySchema,
  loginBodySchema,
  refreshBodySchema,
  logoutBodySchema,
  forgotPasswordBodySchema,
  resetPasswordBodySchema,
} from './auth.schema.js';
import * as authService from './auth.service.js';
import { successResponse } from '../../plugins/error-handler.plugin.js';
import { verifyAccessToken } from '../../lib/tokens.js';

// ── POST /v1/auth/signup  (shop owner — backward compat) ──
// ── POST /v1/auth/signup-shop ──

export async function signupHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = signupBodySchema.parse(request.body);
  const result = await authService.signup(body);
  return reply.status(201).send(successResponse(result));
}

// ── POST /v1/auth/signup-customer ──

export async function signupCustomerHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = signupCustomerBodySchema.parse(request.body);
  const result = await authService.signupCustomer(body);
  return reply.status(201).send(successResponse(result));
}

// ── POST /v1/auth/login ──

export async function loginHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = loginBodySchema.parse(request.body);
  const forwardedFor = request.headers['x-forwarded-for'];
  const ipAddress = (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0]?.trim() : request.ip) || request.ip;
  const headers = request.headers as Record<string, string | string[] | undefined>;
  const location = [headers['x-vercel-ip-city'], headers['x-vercel-ip-country'], headers['cf-ipcity'], headers['cf-ipcountry']]
    .flatMap((value) => Array.isArray(value) ? value : value ? [value] : []).join(', ') || undefined;
  const platform = headers['x-rr-platform']?.toString() || headers['x-client-platform']?.toString();
  const result = await authService.login(body, { ipAddress, location, platform, userAgent: request.headers['user-agent'] });
  return reply.send(successResponse(result));
}

// ── POST /v1/auth/refresh ──

export async function refreshHandler(request: FastifyRequest, reply: FastifyReply) {
  const { refreshToken } = refreshBodySchema.parse(request.body);
  const result = await authService.refresh(refreshToken);
  return reply.send(successResponse(result));
}

// ── POST /v1/auth/logout ──

export async function logoutHandler(request: FastifyRequest, reply: FastifyReply) {
  const { refreshToken } = logoutBodySchema.parse(request.body);
  const user = request.user!;

  // Get the access token expiry for blacklisting
  const authHeader = request.headers.authorization!;
  const accessToken = authHeader.slice(7);
  const decoded = verifyAccessToken(accessToken);

  await authService.logout(user.userId, user.jti, decoded.exp, refreshToken);
  return reply.send(successResponse({ message: 'Logged out successfully' }));
}

// ── POST /v1/auth/forgot-password ──

export async function forgotPasswordHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = forgotPasswordBodySchema.parse(request.body);
  const result = await authService.forgotPassword(body);
  return reply.send(successResponse(result));
}

// ── POST /v1/auth/reset-password ──

export async function resetPasswordHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = resetPasswordBodySchema.parse(request.body);
  const result = await authService.resetPassword(body);
  return reply.send(successResponse(result));
}

// ── GET /v1/me ──

export async function getMeHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user!;
  const result = await authService.getMe(user.userId);
  return reply.send(successResponse(result));
}
