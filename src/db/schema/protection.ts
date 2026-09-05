import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  pgEnum,
  jsonb,
} from 'drizzle-orm/pg-core';
import { shops } from './shops.js';
import { jobs } from './jobs.js';

// ─── Enums ───

export const billingTypeEnum = pgEnum('billing_type', ['ONE_TIME', 'MONTHLY']);

export const planStatusEnum = pgEnum('plan_status', ['ACTIVE', 'PAUSED']);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'ACTIVE',
  'PAST_DUE',
  'CANCELED',
]);

export const claimStatusEnum = pgEnum('claim_status', [
  'OPEN',
  'UNDER_REVIEW',
  'APPROVED',
  'DENIED',
  'COMPLETED',
]);

export const claimUrgencyEnum = pgEnum('claim_urgency', ['LOW', 'MEDIUM', 'HIGH']);

// ─── Protection Plans ───

export const protectionPlans = pgTable('protection_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  billingType: billingTypeEnum('billing_type').notNull(),
  priceCents: integer('price_cents').notNull(),
  coverageDays: integer('coverage_days').notNull().default(0),
  coveredPartTypes: jsonb('covered_part_types').$type<string[]>().notNull().default([]),
  maxClaimsPerPeriod: integer('max_claims_per_period').notNull().default(1),
  maxPayoutPerClaimCents: integer('max_payout_per_claim_cents').notNull(),
  deductibleCents: integer('deductible_cents').notNull().default(0),
  termsText: text('terms_text'),
  exclusionsText: text('exclusions_text'),
  status: planStatusEnum('status').notNull().default('ACTIVE'),
  stripeProductId: varchar('stripe_product_id', { length: 255 }),
  stripePriceId: varchar('stripe_price_id', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Protection Subscribers ───

export const protectionSubscribers = pgTable('protection_subscribers', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id')
    .notNull()
    .references(() => protectionPlans.id, { onDelete: 'cascade' }),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  customerName: varchar('customer_name', { length: 255 }).notNull(),
  status: subscriptionStatusEnum('status').notNull().default('ACTIVE'),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),
  autopayEnabled: boolean('autopay_enabled').notNull().default(true),
  totalPaidCents: integer('total_paid_cents').notNull().default(0),
  claimsCount: integer('claims_count').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  nextBillAt: timestamp('next_bill_at', { withTimezone: true }),
  canceledAt: timestamp('canceled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Protection Claims ───

export const protectionClaims = pgTable('protection_claims', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id')
    .notNull()
    .references(() => protectionPlans.id, { onDelete: 'cascade' }),
  subscriptionId: uuid('subscription_id')
    .notNull()
    .references(() => protectionSubscribers.id, { onDelete: 'cascade' }),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  customerName: varchar('customer_name', { length: 255 }).notNull(),
  jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
  deviceModel: varchar('device_model', { length: 255 }).notNull(),
  reason: text('reason').notNull(),
  evidenceUrls: jsonb('evidence_urls').$type<string[]>().notNull().default([]),
  status: claimStatusEnum('status').notNull().default('OPEN'),
  urgency: claimUrgencyEnum('urgency').notNull().default('LOW'),
  decisionNotes: text('decision_notes'),
  payoutAmountCents: integer('payout_amount_cents').notNull().default(0),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
