import { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../../plugins/auth.plugin.js';
import {
  updateShopHandler,
  updateLocationHandler,
  updateHoursHandler,
  updateServiceAreaHandler,
  submitOnboardingHandler,
  getOnboardingStatusHandler,
} from './onboarding.controller.js';

const onboardingRoutes: FastifyPluginAsync = async (fastify) => {
  // ──── Shop profile (owner/manager) ────

  fastify.patch('/shops/me', {
    preHandler: [fastify.authenticate, requireRole('OWNER', 'MANAGER')],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: updateShopHandler,
  });

  fastify.patch('/shops/me/location', {
    preHandler: [fastify.authenticate, requireRole('OWNER', 'MANAGER')],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: updateLocationHandler,
  });

  fastify.patch('/shops/me/hours', {
    preHandler: [fastify.authenticate, requireRole('OWNER', 'MANAGER')],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: updateHoursHandler,
  });

  fastify.patch('/shops/me/service-area', {
    preHandler: [fastify.authenticate, requireRole('OWNER', 'MANAGER')],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: updateServiceAreaHandler,
  });

  // ──── Onboarding submission ────

  fastify.post('/onboarding/submit', {
    preHandler: [fastify.authenticate, requireRole('OWNER')],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    handler: submitOnboardingHandler,
  });

  fastify.get('/onboarding/status', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: getOnboardingStatusHandler,
  });

  // Admin approve/reject endpoints moved to modules/admin/admin.onboarding.routes.ts
};

export default onboardingRoutes;
