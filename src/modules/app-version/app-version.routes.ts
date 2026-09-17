import { FastifyPluginAsync } from 'fastify';
import { successResponse } from '../../plugins/error-handler.plugin.js';
import { appVersionQuerySchema } from './app-version.schema.js';
import { getAppRelease } from './app-version.service.js';

const appVersionRoutes: FastifyPluginAsync = async (fastify) => {
  // ──── Public route (no auth, no request signature) ────
  // Called by the mobile apps on launch, before login, to drive force-update.
  fastify.get('/app-version', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { app, platform } = appVersionQuerySchema.parse(req.query);
      const release = await getAppRelease(app, platform);
      return reply.send(successResponse(release));
    },
  });
};

export default appVersionRoutes;