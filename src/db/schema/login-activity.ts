import { pgTable, uuid, varchar, text, timestamp, boolean, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/** Security metadata for successful sign-ins. Never store access or refresh tokens here. */
export const loginActivity = pgTable('login_activity', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  userType: varchar('user_type', { length: 20 }).notNull(),
  ipAddress: varchar('ip_address', { length: 64 }),
  location: varchar('location', { length: 255 }),
  deviceName: varchar('device_name', { length: 255 }),
  platform: varchar('platform', { length: 64 }),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('login_activity_user_created_idx').on(table.userId, table.createdAt),
  index('login_activity_created_idx').on(table.createdAt),
]);
