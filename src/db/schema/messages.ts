import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  pgEnum,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { jobs } from './jobs.js';

export const messageTypeEnum = pgEnum('message_type', ['TEXT', 'IMAGE', 'VIDEO']);

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  clientMessageId: varchar('client_message_id', { length: 100 }).notNull(),
  senderId: uuid('sender_id').notNull(),
  senderRole: varchar('sender_role', { length: 20 }).notNull(), // 'SHOP' | 'CUSTOMER'
  type: messageTypeEnum('type').notNull().default('TEXT'),
  text: text('text'),
  mediaUrl: text('media_url'),
  publicId: varchar('public_id', { length: 500 }),
  thumbUrl: text('thumb_url'),
  durationMs: integer('duration_ms'),
  seenAt: timestamp('seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('messages_client_message_id_idx').on(table.jobId, table.clientMessageId),
]);
