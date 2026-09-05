import {
  pgTable,
  uuid,
  integer,
  varchar,
  timestamp,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { shops } from './shops.js';
import { jobs } from './jobs.js';

export const payoutStatusEnum = pgEnum('payout_status', [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
]);

export const payouts = pgTable('payouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  jobId: uuid('job_id')
    .references(() => jobs.id, { onDelete: 'cascade' }),
  amountCents: integer('amount_cents').notNull(),
  platformFeeCents: integer('platform_fee_cents').notNull().default(0),
  netAmountCents: integer('net_amount_cents').notNull().default(0),
  payoutMethod: varchar('payout_method', { length: 32 }),
  stripePayoutId: varchar('stripe_payout_id', { length: 255 }),
  stripeTransferId: varchar('stripe_transfer_id', { length: 255 }),
  status: payoutStatusEnum('status').notNull().default('PENDING'),
  arrivalDate: timestamp('arrival_date', { withTimezone: true }),
  failureMessage: varchar('failure_message', { length: 1000 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
