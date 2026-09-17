import { z } from 'zod';

/** Query params for GET /v1/app-version (public, pre-login). */
export const appVersionQuerySchema = z.object({
  app: z.enum(['store', 'customer']),
  platform: z.enum(['ios', 'android']),
});

export type AppVersionQuery = z.infer<typeof appVersionQuerySchema>;

/** Body for PUT /v1/admin/app-releases/:app/:platform (upsert). */
export const appReleaseUpsertSchema = z.object({
  latestVersion: z.string().min(1).max(20),
  minRequiredVersion: z.string().min(1).max(20),
  storeUrl: z.string().min(1).max(512),
  updateMessage: z.string().max(500).nullable().optional(),
});

export type AppReleaseUpsert = z.infer<typeof appReleaseUpsertSchema>;

export const APP_RELEASE_APPS = ['store', 'customer'] as const;
export const APP_RELEASE_PLATFORMS = ['ios', 'android'] as const;

/** Shape returned to the mobile app. */
export interface AppVersionInfo {
  app: string;
  platform: string;
  latestVersion: string;
  minRequiredVersion: string;
  storeUrl: string;
  updateMessage: string | null;
}