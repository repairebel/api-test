import { pgTable, uuid, timestamp, pgEnum, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { shops } from './shops.js';

export const roleEnum = pgEnum('membership_role', ['OWNER', 'MANAGER', 'TECH']);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('memberships_user_shop_idx').on(table.userId, table.shopId),
  ],
);
