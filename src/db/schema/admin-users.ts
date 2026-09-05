import { pgTable, uuid, varchar, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const adminRoleEnum = pgEnum('admin_role', ['super_admin', 'admin', 'moderator']);
export const adminStatusEnum = pgEnum('admin_status', ['active', 'suspended']);

export const adminUsers = pgTable('admin_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' })
    .unique(),
  name: varchar('name', { length: 255 }).notNull(),
  role: adminRoleEnum('role').notNull().default('admin'),
  status: adminStatusEnum('status').notNull().default('active'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
