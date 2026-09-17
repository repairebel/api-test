import {
  pgEnum,
  pgTable,
  uuid,
  integer,
  varchar,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { jobs } from './jobs.js';
import { shops } from './shops.js';

export const orderAdjustmentStatusEnum = pgEnum('order_adjustment_status', [
  'REQUESTED',
  'AUTHORIZED',
  'DECLINED',
  'CANCELLED',
  'CAPTURED',
  'REFUNDED',
  'FAILED',
]);

export const orderAdjustments = pgTable('order_adjustments', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  previousPriceCents: integer('previous_price_cents').notNull(),
  adjustmentCents: integer('adjustment_cents').notNull(),
  newTotalCents: integer('new_total_cents').notNull(),
  status: orderAdjustmentStatusEnum('status').notNull().default('REQUESTED'),
  stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }),
  stripeTransferId: varchar('stripe_transfer_id', { length: 255 }),
  paymentError: varchar('payment_error', { length: 1000 }),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const orderTipStatusEnum = pgEnum('order_tip_status', [
  'PENDING',
  'COMPLETED',
  'FAILED',
]);

export const orderTips = pgTable('order_tips', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  amountCents: integer('amount_cents').notNull(),
  platformFeeCents: integer('platform_fee_cents').notNull().default(0),
  status: orderTipStatusEnum('status').notNull().default('PENDING'),
  stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }),
  stripeTransferId: varchar('stripe_transfer_id', { length: 255 }),
  paymentError: varchar('payment_error', { length: 1000 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique('order_tips_job_id_unique').on(table.jobId)]);
