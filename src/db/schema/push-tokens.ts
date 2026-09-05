import { pgTable, uuid, text, varchar, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const appTypeEnum = pgEnum('app_type', ['STORE', 'CUSTOMER']);

export const pushTokens = pgTable('push_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  platform: varchar('platform', { length: 10 }).notNull(), // 'ios' | 'android'
  appType: appTypeEnum('app_type').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
