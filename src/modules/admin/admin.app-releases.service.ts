import { eq, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { appReleases } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import type { AppReleaseUpsert, AppVersionInfo } from '../app-version/app-version.schema.js';

function toInfo(row: typeof appReleases.$inferSelect): AppVersionInfo {
  return {
    app: row.app,
    platform: row.platform,
    latestVersion: row.latestVersion,
    minRequiredVersion: row.minRequiredVersion,
    storeUrl: row.storeUrl,
    updateMessage: row.updateMessage,
  };
}

export async function listAppReleases(): Promise<AppVersionInfo[]> {
  const rows = await db.select().from(appReleases).orderBy(appReleases.app, appReleases.platform);
  return rows.map(toInfo);
}

export async function getAppReleaseRow(app: string, platform: string): Promise<AppVersionInfo> {
  const [row] = await db
    .select()
    .from(appReleases)
    .where(and(eq(appReleases.app, app), eq(appReleases.platform, platform)))
    .limit(1);

  if (!row) {
    throw new AppError(404, ErrorCode.NOT_FOUND, `No release configuration for app=${app} platform=${platform}`);
  }
  return toInfo(row);
}

/**
 * Create or update the release row for a given app + platform.
 * The (app, platform) pair is unique; on conflict we update the version fields.
 */
export async function upsertAppRelease(
  app: string,
  platform: string,
  data: AppReleaseUpsert,
): Promise<AppVersionInfo> {
  const [row] = await db
    .insert(appReleases)
    .values({
      app,
      platform,
      latestVersion: data.latestVersion,
      minRequiredVersion: data.minRequiredVersion,
      storeUrl: data.storeUrl,
      updateMessage: data.updateMessage ?? null,
    })
    .onConflictDoUpdate({
      target: [appReleases.app, appReleases.platform],
      set: {
        latestVersion: data.latestVersion,
        minRequiredVersion: data.minRequiredVersion,
        storeUrl: data.storeUrl,
        updateMessage: data.updateMessage ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  return toInfo(row);
}