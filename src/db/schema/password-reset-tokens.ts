import { pgTable, uuid, varchar, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('password_reset_tokens_token_hash_idx').on(table.tokenHash),
    index('password_reset_tokens_user_id_idx').on(table.userId),
  ],
);
