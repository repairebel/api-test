import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  pgEnum,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { shops } from './shops.js';
import { jobs } from './jobs.js';

// ─── Enums ───

export const reviewMediaTypeEnum = pgEnum('review_media_type', ['IMAGE', 'VIDEO']);

// ─── Reviews ───

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').notNull(),
    customerName: varchar('customer_name', { length: 255 }).notNull(),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    rating: integer('rating').notNull(), // 1-5
    text: text('text'),
    isHidden: boolean('is_hidden').notNull().default(false),
    isReported: boolean('is_reported').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_reviews_shop_created').on(t.shopId, t.createdAt),
    index('idx_reviews_shop_rating').on(t.shopId, t.rating),
    unique('reviews_job_customer_key').on(t.jobId, t.customerId),
  ],
);

// ─── Review Media ───

export const reviewMedia = pgTable('review_media', {
  id: uuid('id').primaryKey().defaultRandom(),
  reviewId: uuid('review_id')
    .notNull()
    .references(() => reviews.id, { onDelete: 'cascade' }),
  type: reviewMediaTypeEnum('type').notNull(),
  url: varchar('url', { length: 1000 }).notNull(),
  publicId: varchar('public_id', { length: 500 }),
  thumbUrl: varchar('thumb_url', { length: 1000 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Review Replies ───

export const reviewReplies = pgTable(
  'review_replies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    replierUserId: uuid('replier_user_id').notNull(),
    text: text('text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('review_replies_review_id_key').on(t.reviewId), // one reply per review
  ],
);

// ─── Review Reports ───

export const reviewReports = pgTable('review_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  reviewId: uuid('review_id')
    .notNull()
    .references(() => reviews.id, { onDelete: 'cascade' }),
  reporterUserId: uuid('reporter_user_id').notNull(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  reason: varchar('reason', { length: 100 }).notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
