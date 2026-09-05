import { pgTable, uuid, text, varchar, boolean, timestamp, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const notificationTargetEnum = pgEnum('notification_target', ['STORE', 'CUSTOMER', 'ADMIN']);

export const notificationCategoryEnum = pgEnum('notification_category', [
  'order',
  'dispatch',
  'chat',
  'dispute',
  'payout',
  'review',
  'system',
  'offer',
  'protection',
]);

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  targetType: notificationTargetEnum('target_type').notNull(),
  category: notificationCategoryEnum('category').notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  body: text('body').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().default({}),
  read: boolean('read').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
