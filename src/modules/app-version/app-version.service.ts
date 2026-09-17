import { eq, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { appReleases } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import type { AppVersionInfo } from './app-version.schema.js';

/**
 * Returns the release metadata for a given app + platform.
 * Used by the public GET /v1/app-version endpoint.
 */
export async function getAppRelease(app: string, platform: string): Promise<AppVersionInfo> {
  const [row] = await db
    .select()
    .from(appReleases)
    .where(and(eq(appReleases.app, app), eq(appReleases.platform, platform)))
    .limit(1);

  if (!row) {
    throw new AppError(
      404,
      ErrorCode.NOT_FOUND,
      `No release configuration for app=${app} platform=${platform}`,
    );
  }

  return {
    app: row.app,
    platform: row.platform,
    latestVersion: row.latestVersion,
    minRequiredVersion: row.minRequiredVersion,
    storeUrl: row.storeUrl,
    updateMessage: row.updateMessage,
  };
}