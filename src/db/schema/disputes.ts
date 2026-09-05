import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  jsonb,
} from 'drizzle-orm/pg-core';
import { jobs } from './jobs.js';
import { shops } from './shops.js';

// ── Enums ──

export const disputeStatusEnum = pgEnum('dispute_status', [
  'OPEN',
  'IN_PROGRESS',
  'UNDER_REVIEW',
  'FINALIZING',
  'RESOLVED_REFUND',
  'RESOLVED_RELEASED',
  'REJECTED',
]);

export const disputeReasonCodeEnum = pgEnum('dispute_reason_code', [
  'DEVICE_NOT_FIXED',
  'NEW_DAMAGE',
  'WRONG_REPAIR',
  'MISSING_PARTS',
  'OVERCHARGED',
  'OTHER',
]);

export const disputeSenderRoleEnum = pgEnum('dispute_sender_role', [
  'CUSTOMER',
  'SHOP',
  'ADMIN',
]);

// ── Disputes table ──

export const disputes = pgTable('disputes', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  reasonCode: disputeReasonCodeEnum('reason_code').notNull(),
  description: text('description').notNull(),
  evidenceUrls: jsonb('evidence_urls').$type<string[]>().default([]),
  disputeVideoUrl: text('dispute_video_url'),
  disputeVideoDurationMs: text('dispute_video_duration_ms'),
  status: disputeStatusEnum('status').notNull().default('OPEN'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Dispute messages table (conversation thread) ──

export const disputeMessages = pgTable('dispute_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  disputeId: uuid('dispute_id')
    .notNull()
    .references(() => disputes.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id').notNull(),
  senderRole: disputeSenderRoleEnum('sender_role').notNull(),
  message: text('message').notNull(),
  evidenceUrls: jsonb('evidence_urls').$type<string[]>().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
