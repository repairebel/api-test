import { pgTable, uuid, varchar, boolean, text, integer, timestamp, pgEnum, jsonb } from 'drizzle-orm/pg-core';

export const onboardingStatusEnum = pgEnum('onboarding_status', [
  'NOT_STARTED',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
]);

/** Schema for a single day's business hours. Supports 12-hour AM/PM (e.g. '12:00 PM', '12:00 AM') or 24-hour ('09:00'). */
export interface DaySchedule {
  day: string;        // 'Monday', 'Tuesday', etc.
  isOpen: boolean;
  openTime: string;   // e.g. '12:00 PM' or '09:00'
  closeTime: string;  // e.g. '12:00 AM' or '18:00'
}

/** Per-part-type warranty override. */
export interface PartWarrantyOverride {
  partType: string;
  days: number;
  enabled: boolean;
}

export const shops = pgTable('shops', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  onboardingStatus: onboardingStatusEnum('onboarding_status').notNull().default('NOT_STARTED'),
  rejectionReason: text('rejection_reason'),

  // Stripe
  stripeAccountId: varchar('stripe_account_id', { length: 255 }),
  stripeConnected: boolean('stripe_connected').notNull().default(false),
  stripeChargesEnabled: boolean('stripe_charges_enabled').notNull().default(false),
  stripePayoutsEnabled: boolean('stripe_payouts_enabled').notNull().default(false),
  manualPayoutFreeze: boolean('manual_payout_freeze').notNull().default(false),
  manualPayoutFreezeReason: text('manual_payout_freeze_reason'),
  manualPayoutFrozenAt: timestamp('manual_payout_frozen_at', { withTimezone: true }),
  manualPayoutFrozenByAdminId: uuid('manual_payout_frozen_by_admin_id'),
  stripePayoutFreezeCode: varchar('stripe_payout_freeze_code', { length: 255 }),
  stripePayoutFreezeReason: text('stripe_payout_freeze_reason'),
  stripePayoutStatusSyncedAt: timestamp('stripe_payout_status_synced_at', { withTimezone: true }),

  // General
  vacationMode: boolean('vacation_mode').notNull().default(false),
  phone: varchar('phone', { length: 30 }),
  publicEmail: varchar('public_email', { length: 255 }),
  website: varchar('website', { length: 500 }),
  description: text('description'),
  categories: jsonb('categories').$type<string[]>().default([]),
  logoUrl: varchar('logo_url', { length: 1000 }),

  // Location
  address: text('address'),
  city: varchar('city', { length: 100 }),
  state: varchar('state', { length: 100 }),
  zipCode: varchar('zip_code', { length: 20 }),
  country: varchar('country', { length: 100 }),
  placeId: varchar('place_id', { length: 300 }),
  latitude: varchar('latitude', { length: 20 }),
  longitude: varchar('longitude', { length: 20 }),
  serviceRadius: integer('service_radius'), // in km

  // Business hours
  businessHours: jsonb('business_hours').$type<DaySchedule[]>(),

  // Warranty
  warrantyEnabled: boolean('warranty_enabled').notNull().default(false),
  defaultWarrantyDays: integer('default_warranty_days').notNull().default(90),
  perPartWarrantyOverrides: jsonb('per_part_warranty_overrides').$type<PartWarrantyOverride[]>().default([]),
  warrantyPolicyText: text('warranty_policy_text'),

  // Priority (admin-controlled dispatch weighting)
  priorityEnabled: boolean('priority_enabled').notNull().default(false),
  priorityLevel: integer('priority_level'), // 1–5 (1 = highest)

  // Protection plans
  protectionEnabled: boolean('protection_enabled').notNull().default(false),

  // Notification preferences
  notificationSound: boolean('notification_sound').notNull().default(true),
  notificationVibration: boolean('notification_vibration').notNull().default(true),
  quietHoursStart: varchar('quiet_hours_start', { length: 5 }), // HH:MM
  quietHoursEnd: varchar('quiet_hours_end', { length: 5 }),       // HH:MM

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
