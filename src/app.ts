import Fastify, { FastifyInstance } from 'fastify';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import { env } from './config/env.js';

// Plugins
import errorHandlerPlugin from './plugins/error-handler.plugin.js';
import rateLimitPlugin from './plugins/rate-limit.plugin.js';
import idempotencyPlugin from './plugins/idempotency.plugin.js';
import authPlugin from './plugins/auth.plugin.js';

// Routes
import authRoutes from './modules/auth/auth.routes.js';
import onboardingRoutes from './modules/onboarding/onboarding.routes.js';
import requestsRoutes from './modules/requests/requests.routes.js';
import dispatchRoutes from './modules/dispatch/dispatch.routes.js';
import jobsRoutes from './modules/jobs/jobs.routes.js';
import mediaRoutes from './modules/media/media.routes.js';
import chatRoutes from './modules/chat/chat.routes.js';
import inventoryRoutes from './modules/inventory/inventory.routes.js';
import earningsRoutes from './modules/earnings/earnings.routes.js';
import protectionRoutes from './modules/protection/protection.routes.js';
import customerProtectionRoutes from './modules/protection/customer-protection.routes.js';
import settingsRoutes from './modules/settings/settings.routes.js';
import reviewsRoutes from './modules/reviews/reviews.routes.js';
import customerRequestsRoutes from './modules/requests/customer-requests.routes.js';
import disputesRoutes from './modules/disputes/disputes.routes.js';
import customerSettingsRoutes from './modules/customer-settings/customer-settings.routes.js';
import notificationsRoutes from './modules/notifications/notifications.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport:
        env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
    trustProxy: true,
  });

  // ── Security ──
  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      // Request-signature headers sent by the mobile/web clients (see auth.plugin.ts).
      // These must be listed here or browsers block the preflight on cross-origin requests.
      'x-rr-ts',
      'x-rr-nonce',
      'x-rr-signature',
      'x-rr-client',
    ],
    credentials: true,
  });
  await app.register(sensible);

  // ── Infrastructure plugins ──
  await app.register(errorHandlerPlugin);
  await app.register(rateLimitPlugin);
  await app.register(idempotencyPlugin);
  await app.register(authPlugin);

  // ── Health check ──
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }));

  app.get('/stripe/return', async (request, reply) => {
    const { app: appName } = request.query as { app?: string };
    const appUrl =
      appName === 'store'
        ? 'repairebel-app://settings/stripe-setup?stripe=return'
        : 'repairebel-app://settings/stripe-setup?stripe=return';

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Return to RepairRebel</title>
    <meta http-equiv="refresh" content="0;url=${appUrl}" />
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #0a0a0d;
        color: #f5f5f7;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .card {
        width: min(440px, calc(100vw - 32px));
        padding: 28px;
        border-radius: 24px;
        background: #15151a;
        border: 1px solid #26262f;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 26px;
      }
      p {
        margin: 0 0 20px;
        color: #a1a1aa;
        line-height: 1.5;
      }
      a {
        display: inline-block;
        padding: 14px 18px;
        border-radius: 14px;
        background: #ff3b30;
        color: #fff;
        text-decoration: none;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Back to RepairRebel</h1>
      <p>Your Stripe setup is complete. If the app does not open automatically, use the button below.</p>
      <a href="${appUrl}">Open the app</a>
    </div>
    <script>
      window.location.replace(${JSON.stringify(appUrl)});
      setTimeout(function () {
        window.location.href = ${JSON.stringify(appUrl)};
      }, 400);
    </script>
  </body>
</html>`;

    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/stripe/refresh', async (request, reply) => {
    const { app: appName } = request.query as { app?: string };
    const appUrl =
      appName === 'store'
        ? 'repairebel-app://settings/stripe-setup?stripe=refresh'
        : 'repairebel-app://settings/stripe-setup?stripe=refresh';

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Continue Stripe Setup</title>
    <meta http-equiv="refresh" content="0;url=${appUrl}" />
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #0a0a0d;
        color: #f5f5f7;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .card {
        width: min(440px, calc(100vw - 32px));
        padding: 28px;
        border-radius: 24px;
        background: #15151a;
        border: 1px solid #26262f;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 26px;
      }
      p {
        margin: 0 0 20px;
        color: #a1a1aa;
        line-height: 1.5;
      }
      a {
        display: inline-block;
        padding: 14px 18px;
        border-radius: 14px;
        background: #ff3b30;
        color: #fff;
        text-decoration: none;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Continue in the app</h1>
      <p>This Stripe link expired or was reopened. Go back to the payout screen and start the setup again.</p>
      <a href="${appUrl}">Return to the app</a>
    </div>
    <script>
      window.location.replace(${JSON.stringify(appUrl)});
      setTimeout(function () {
        window.location.href = ${JSON.stringify(appUrl)};
      }, 400);
    </script>
  </body>
</html>`;

    return reply.type('text/html; charset=utf-8').send(html);
  });

  // ── API v1 routes ──
  await app.register(authRoutes, { prefix: '/v1' });
  await app.register(onboardingRoutes, { prefix: '/v1' });
  await app.register(requestsRoutes, { prefix: '/v1' });
  await app.register(dispatchRoutes, { prefix: '/v1' });
  await app.register(jobsRoutes, { prefix: '/v1' });
  await app.register(mediaRoutes, { prefix: '/v1' });
  await app.register(chatRoutes, { prefix: '/v1' });
  await app.register(inventoryRoutes, { prefix: '/v1' });
  await app.register(earningsRoutes, { prefix: '/v1' });
  await app.register(protectionRoutes, { prefix: '/v1' });
  await app.register(customerProtectionRoutes, { prefix: '/v1' });
  await app.register(settingsRoutes, { prefix: '/v1' });
  await app.register(reviewsRoutes, { prefix: '/v1' });
  await app.register(customerRequestsRoutes, { prefix: '/v1' });
  await app.register(disputesRoutes, { prefix: '/v1' });
  await app.register(customerSettingsRoutes, { prefix: '/v1' });
  await app.register(notificationsRoutes, { prefix: '/v1' });
  await app.register(adminRoutes, { prefix: '/v1' });

  return app;
}
