import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  pgEnum,
  jsonb,
} from 'drizzle-orm/pg-core';
import { requests } from './requests.js';
import { offers } from './offers.js';
import { shops } from './shops.js';

export const jobStatusEnum = pgEnum('job_status', [
  'BOOKED',
  'CHECKED_IN',
  'IN_PROGRESS',
  'READY',
  'COMPLETED',
  'DISPUTED',
  'CANCELLED',
]);

export const paymentStatusEnum = pgEnum('payment_status', [
  'HELD',
  'CAPTURED',
  'RELEASED',
  'REFUNDED',
  'PAYMENT_FAILED',
]);

export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id')
    .notNull()
    .references(() => requests.id, { onDelete: 'cascade' }),
  offerId: uuid('offer_id')
    .notNull()
    .references(() => offers.id, { onDelete: 'cascade' }),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  customerName: varchar('customer_name', { length: 255 }).notNull(),
  deviceBrand: varchar('device_brand', { length: 100 }).notNull(),
  deviceModel: varchar('device_model', { length: 255 }).notNull(),
  issueDescription: text('issue_description').notNull(),
  priceCents: integer('price_cents').notNull(),
  etaMinutes: integer('eta_minutes').notNull(),
  warrantyDays: integer('warranty_days').notNull().default(0),
  partsQuality: varchar('parts_quality', { length: 20 }).notNull().default('AFTERMARKET'),
  status: jobStatusEnum('status').notNull().default('BOOKED'),
  paymentStatus: paymentStatusEnum('payment_status').notNull().default('HELD'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }),
  platformFeeCents: integer('platform_fee_cents').notNull().default(0),
  proofMedia: jsonb('proof_media').$type<string[]>().default([]),
  customerInitialVideoUrl: text('customer_initial_video_url'),
  shopCompletionVideoUrl: text('shop_completion_video_url'),
  disputeReason: text('dispute_reason'),
  paymentError: text('payment_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jobStatusEvents = pgTable('job_status_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  fromStatus: varchar('from_status', { length: 30 }),
  toStatus: varchar('to_status', { length: 30 }).notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
