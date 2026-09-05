import { pgTable, uuid, boolean } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const customerNotificationPrefs = pgTable('customer_notification_prefs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  offers: boolean('offers').notNull().default(true),
  messages: boolean('messages').notNull().default(true),
  orderUpdates: boolean('order_updates').notNull().default(true),
  payments: boolean('payments').notNull().default(true),
  reviews: boolean('reviews').notNull().default(false),
  promotions: boolean('promotions').notNull().default(false),
});
