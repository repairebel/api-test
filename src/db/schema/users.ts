import { pgTable, uuid, varchar, text, timestamp, pgEnum, unique, boolean } from 'drizzle-orm/pg-core';

export const userTypeEnum = pgEnum('user_type', ['CUSTOMER', 'SHOP_OWNER', 'ADMIN']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  fullName: varchar('full_name', { length: 255 }),
  phone: varchar('phone', { length: 20 }).unique(),
  avatarUrl: text('avatar_url'),
  userType: userTypeEnum('user_type').notNull().default('SHOP_OWNER'),
  stripeCustomerId: text('stripe_customer_id'),
  status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
  // Privacy preferences (customer only)
  privacyShareUsage: boolean('privacy_share_usage').notNull().default(true),
  privacyShareLocation: boolean('privacy_share_location').notNull().default(true),
  privacyShareRepairHistory: boolean('privacy_share_repair_history').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('users_email_user_type_unique').on(t.email, t.userType),
]);
