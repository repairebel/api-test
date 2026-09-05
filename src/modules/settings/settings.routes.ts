import { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../../plugins/auth.plugin.js';
import {
  getShopProfileHandler,
  updateWarrantyHandler,
  updateVacationHandler,
  updateNotificationsHandler,
  updateLocationExtHandler,
  startStripeConnectHandler,
  getStripeStatusHandler,
  getShopTaxDocumentsHandler,
  createShopTaxDocumentsAccessLinkHandler,
  disconnectStripeHandler,
  updateProtectionEnabledHandler,
} from './settings.controller.js';

const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  // ──── Get full shop profile ────

  fastify.get('/shops/me/profile', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: getShopProfileHandler,
  });

  // ──── Warranty settings ────

  fastify.patch('/shops/me/warranty', {
    preHandler: [fastify.authenticate, requireRole('OWNER', 'MANAGER')],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: updateWarrantyHandler,
  });

  // ──── Vacation mode ────

  fastify.patch('/shops/me/vacation', {
    preHandler: [fastify.authenticate, requireRole('OWNER', 'MANAGER')],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: updateVacationHandler,
  });

  // ──── Notification preferences ────

  fastify.patch('/shops/me/notifications', {
    preHandler: [fastify.authenticate, requireRole('OWNER', 'MANAGER')],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: updateNotificationsHandler,
  });

  // ──── Location (extended with city/state/zip/country) ────

  fastify.patch('/shops/me/location-ext', {
    preHandler: [fastify.authenticate, requireRole('OWNER', 'MANAGER')],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: updateLocationExtHandler,
  });

  // ──── Protection enabled toggle ────

  fastify.patch('/shops/me/protection-enabled', {
    preHandler: [fastify.authenticate, requireRole('OWNER', 'MANAGER')],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: updateProtectionEnabledHandler,
  });

  // ──── Stripe Connect ────

  fastify.post('/stripe/connect/start', {
    preHandler: [fastify.authenticate, requireRole('OWNER')],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    handler: startStripeConnectHandler,
  });

  fastify.get('/stripe/connect/status', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: getStripeStatusHandler,
  });

  fastify.get('/shops/me/tax-documents', {
    preHandler: [fastify.authenticate, requireRole('OWNER', 'MANAGER')],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: getShopTaxDocumentsHandler,
  });

  fastify.post('/shops/me/tax-documents/access-link', {
    preHandler: [fastify.authenticate, requireRole('OWNER', 'MANAGER')],
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
    handler: createShopTaxDocumentsAccessLinkHandler,
  });

  fastify.post('/stripe/connect/disconnect', {
    preHandler: [fastify.authenticate, requireRole('OWNER')],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    handler: disconnectStripeHandler,
  });
};

export default settingsRoutes;
