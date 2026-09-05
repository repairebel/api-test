import { FastifyPluginAsync } from 'fastify';

import dashboardRoutes from './admin.dashboard.routes.js';
import usersRoutes from './admin.users.routes.js';
import shopsRoutes from './admin.shops.routes.js';
import requestsRoutes from './admin.requests.routes.js';
import ordersRoutes from './admin.orders.routes.js';
import jobsRoutes from './admin.jobs.routes.js';
import inventoryRoutes from './admin.inventory.routes.js';
import deviceModelsRoutes from './admin.device-models.routes.js';
import disputesRoutes from './admin.disputes.routes.js';
import reviewsRoutes from './admin.reviews.routes.js';
import protectionRoutes from './admin.protection.routes.js';
import financeRoutes from './admin.finance.routes.js';
import payoutsRoutes from './admin.payouts.routes.js';
import connectedAccountsRoutes from './admin.connected-accounts.routes.js';
import chatRoutes from './admin.chat.routes.js';
import supportRoutes from './admin.support.routes.js';
import pushRoutes from './admin.push.routes.js';
import onboardingRoutes from './admin.onboarding.routes.js';
import adminsRoutes from './admin.admins.routes.js';
import auditRoutes from './admin.audit.routes.js';
import settingsRoutes from './admin.settings.routes.js';
import profileRoutes from './admin.profile.routes.js';
import broadcastRoutes from './admin.broadcast.routes.js';

/**
 * Main admin module entry point.
 * Registers all admin sub-route modules.
 */
const adminRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(dashboardRoutes);
  await fastify.register(usersRoutes);
  await fastify.register(shopsRoutes);
  await fastify.register(requestsRoutes);
  await fastify.register(ordersRoutes);
  await fastify.register(jobsRoutes);
  await fastify.register(inventoryRoutes);
  await fastify.register(deviceModelsRoutes);
  await fastify.register(disputesRoutes);
  await fastify.register(reviewsRoutes);
  await fastify.register(protectionRoutes);
  await fastify.register(financeRoutes);
  await fastify.register(payoutsRoutes);
  await fastify.register(connectedAccountsRoutes);
  await fastify.register(chatRoutes);
  await fastify.register(supportRoutes);
  await fastify.register(pushRoutes);
  await fastify.register(onboardingRoutes);
  await fastify.register(adminsRoutes);
  await fastify.register(auditRoutes);
  await fastify.register(settingsRoutes);
  await fastify.register(profileRoutes);
  await fastify.register(broadcastRoutes);
};

export default adminRoutes;
