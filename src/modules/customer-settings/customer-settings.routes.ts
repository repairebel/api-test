import { FastifyPluginAsync } from 'fastify';
import {
  updateProfileHandler,
  changePasswordHandler,
  changeEmailHandler,
  getStatsHandler,
  listAddressesHandler,
  createAddressHandler,
  updateAddressHandler,
  deleteAddressHandler,
  listPaymentMethodsHandler,
  createSetupIntentHandler,
  confirmSetupHandler,
  confirmSetupWithTokenHandler,
  deletePaymentMethodHandler,
  setDefaultPaymentMethodHandler,
  getNotificationPrefsHandler,
  updateNotificationPrefsHandler,
  getPrivacySettingsHandler,
  updatePrivacySettingsHandler,
  deleteAccountHandler,
  exportDataHandler,
  chatHandler,
  listConversationsHandler,
  getChatHistoryHandler,
  connectAgentHandler,
  checkAgentAvailableHandler,
  sendCustomerSupportMessageHandler,
  getCustomerSupportConversationHandler,
  listCustomerSupportConversationsHandler,
} from './customer-settings.controller.js';

const customerSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: [fastify.authenticate] };

  // ── Profile ──
  fastify.patch('/me/profile', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, handler: updateProfileHandler });
  fastify.post('/auth/change-password', { ...auth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, handler: changePasswordHandler });
  fastify.post('/auth/change-email', { ...auth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, handler: changeEmailHandler });
  fastify.get('/customer/stats', { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, handler: getStatsHandler });

  // ── Addresses ──
  fastify.get('/customer/addresses', { ...auth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } }, handler: listAddressesHandler });
  fastify.post('/customer/addresses', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, handler: createAddressHandler });
  fastify.patch('/customer/addresses/:id', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, handler: updateAddressHandler });
  fastify.delete('/customer/addresses/:id', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, handler: deleteAddressHandler });

  // ── Payment Methods ──
  fastify.get('/customer/payment-methods', { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, handler: listPaymentMethodsHandler });
  fastify.post('/customer/payment-methods/setup-intent', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, handler: createSetupIntentHandler });
  fastify.post('/customer/payment-methods/confirm', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, handler: confirmSetupHandler });
  fastify.post('/customer/payment-methods/confirm-token', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, handler: confirmSetupWithTokenHandler });
  fastify.delete('/customer/payment-methods/:id', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, handler: deletePaymentMethodHandler });
  fastify.patch('/customer/payment-methods/:id/default', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, handler: setDefaultPaymentMethodHandler });

  // ── Notification Preferences ──
  fastify.get('/customer/notification-prefs', { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, handler: getNotificationPrefsHandler });
  fastify.patch('/customer/notification-prefs', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, handler: updateNotificationPrefsHandler });

  // ── Privacy ──
  fastify.get('/customer/privacy-settings', { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, handler: getPrivacySettingsHandler });
  fastify.patch('/customer/privacy-settings', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, handler: updatePrivacySettingsHandler });
  fastify.delete('/customer/account', { ...auth, config: { rateLimit: { max: 3, timeWindow: '1 minute' } }, handler: deleteAccountHandler });
  fastify.post('/customer/data-export', { ...auth, config: { rateLimit: { max: 3, timeWindow: '1 minute' } }, handler: exportDataHandler });

  // ── Support Chat (AI) ──
  fastify.post('/customer/support/chat', { ...auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, handler: chatHandler });
  fastify.get('/customer/support/conversations', { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, handler: listConversationsHandler });
  fastify.get('/customer/support/conversations/:id', { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, handler: getChatHistoryHandler });

  // ── Support: Connect to Live Agent ──
  fastify.get('/customer/support/agent-available', { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, handler: checkAgentAvailableHandler });
  fastify.post('/customer/support/connect-agent', { ...auth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, handler: connectAgentHandler });
  fastify.post('/customer/support/conversations/:id/message', { ...auth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } }, handler: sendCustomerSupportMessageHandler });
  fastify.get('/customer/support/agent-conversations', { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, handler: listCustomerSupportConversationsHandler });
  fastify.get('/customer/support/agent-conversations/:id', { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, handler: getCustomerSupportConversationHandler });
};

export default customerSettingsRoutes;
