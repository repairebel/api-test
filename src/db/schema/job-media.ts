import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { jobs } from './jobs.js';

export const mediaTypeEnum = pgEnum('media_type', ['IMAGE', 'VIDEO']);

export const jobMedia = pgTable('job_media', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  shopId: uuid('shop_id').notNull(),
  type: mediaTypeEnum('type').notNull(),
  url: text('url').notNull(),
  publicId: varchar('public_id', { length: 500 }).notNull(),
  thumbUrl: text('thumb_url'),
  durationMs: integer('duration_ms'),
  sizeBytes: integer('size_bytes'),
  mimeType: varchar('mime_type', { length: 100 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
