import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse, AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import {
  appReleaseUpsertSchema,
  APP_RELEASE_APPS,
  APP_RELEASE_PLATFORMS,
} from '../app-version/app-version.schema.js';
import {
  listAppReleases,
  getAppReleaseRow,
  upsertAppRelease,
} from './admin.app-releases.service.js';

const appReleasesAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/app-releases', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (_req, reply) => {
      const releases = await listAppReleases();
      return reply.send(successResponse(releases));
    },
  });

  fastify.get('/admin/app-releases/:app/:platform', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { app, platform } = req.params as { app: string; platform: string };
      const release = await getAppReleaseRow(app, platform);
      return reply.send(successResponse(release));
    },
  });

  fastify.put('/admin/app-releases/:app/:platform', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { app, platform } = req.params as { app: string; platform: string };
      if (!APP_RELEASE_APPS.includes(app as (typeof APP_RELEASE_APPS)[number])) {
        throw new AppError(400, ErrorCode.VALIDATION_ERROR, `app must be one of: ${APP_RELEASE_APPS.join(', ')}`);
      }
      if (!APP_RELEASE_PLATFORMS.includes(platform as (typeof APP_RELEASE_PLATFORMS)[number])) {
        throw new AppError(
          400,
          ErrorCode.VALIDATION_ERROR,
          `platform must be one of: ${APP_RELEASE_PLATFORMS.join(', ')}`,
        );
      }

      const body = appReleaseUpsertSchema.parse(req.body);
      const release = await upsertAppRelease(app, platform, body);
      await logAudit(
        req.user!.userId,
        `Upserted app release ${app}/${platform} (min=${body.minRequiredVersion}, latest=${body.latestVersion})`,
        'settings',
      );
      return reply.send(successResponse(release));
    },
  });
};

export default appReleasesAdminRoutes;