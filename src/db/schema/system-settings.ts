import { pgTable, uuid, integer, boolean, timestamp, varchar } from 'drizzle-orm/pg-core';

/**
 * Single-row table holding global platform settings.
 * All fields have defaults — the seed script inserts row with id = fixed UUID.
 */
export const systemSettings = pgTable('system_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  commissionPercent: integer('commission_percent').notNull().default(15),
  insurancePercent: integer('insurance_percent').notNull().default(5),
  instantCashoutEnabled: boolean('instant_cashout_enabled').notNull().default(false),
  maxInstantCashoutCents: integer('max_instant_cashout_cents').notNull().default(50000),
  dispatchRadiusKm: integer('dispatch_radius_km').notNull().default(25),
  refundLimitAdmin: integer('refund_limit_admin').notNull().default(500),
  refundLimitModerator: integer('refund_limit_moderator').notNull().default(0),
  disputeAutoCloseDays: integer('dispute_auto_close_days').notNull().default(14),
  maintenanceMode: boolean('maintenance_mode').notNull().default(false),

  // Cloudinary
  cloudinaryCloudName: varchar('cloudinary_cloud_name', { length: 255 }),
  cloudinaryApiKey: varchar('cloudinary_api_key', { length: 255 }),
  cloudinaryApiSecret: varchar('cloudinary_api_secret', { length: 255 }),

  // Stripe
  stripeSecretKey: varchar('stripe_secret_key', { length: 512 }),
  stripePublishableKey: varchar('stripe_publishable_key', { length: 512 }),
  stripeWebhookSecret: varchar('stripe_webhook_secret', { length: 512 }),

  // SMTP
  smtpHost: varchar('smtp_host', { length: 255 }),
  smtpPort: integer('smtp_port'),
  smtpUser: varchar('smtp_user', { length: 255 }),
  smtpPass: varchar('smtp_pass', { length: 512 }),
  smtpFrom: varchar('smtp_from', { length: 255 }),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
