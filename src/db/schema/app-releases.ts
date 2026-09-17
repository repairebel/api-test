import { pgTable, uuid, varchar, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Per-app, per-platform release metadata used to drive in-app force-update.
 *
 * The mobile apps (Store + Customer) call the public `GET /v1/app-version`
 * endpoint on launch and compare their installed marketing version against:
 *   - `minRequiredVersion` → if installed is older, block behind the
 *     ForceUpdateScreen (non-dismissible, deep-links to `storeUrl`).
 *   - `latestVersion` → if installed is older (but >= min), show a dismissible
 *     soft-update bottom sheet.
 *
 * Rows are managed via the admin API (`/v1/admin/app-releases`) so minimum
 * versions can be raised without a server redeploy.
 */
export const appReleases = pgTable(
  'app_releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // 'store' | 'customer'
    app: varchar('app', { length: 20 }).notNull(),
    // 'ios' | 'android'
    platform: varchar('platform', { length: 10 }).notNull(),
    latestVersion: varchar('latest_version', { length: 20 }).notNull(),
    minRequiredVersion: varchar('min_required_version', { length: 20 }).notNull(),
    // Play Store / App Store URL the app opens via Linking.openURL.
    storeUrl: varchar('store_url', { length: 512 }).notNull(),
    // Optional body copy for the update prompt.
    updateMessage: text('update_message'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('app_releases_app_platform_idx').on(table.app, table.platform),
  ],
);