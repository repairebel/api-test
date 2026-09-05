import { pgTable, uuid, varchar, text, timestamp, boolean, doublePrecision } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const customerAddresses = pgTable('customer_addresses', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  label: varchar('label', { length: 50 }).notNull(),
  address: text('address').notNull(),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  city: varchar('city', { length: 100 }),
  state: varchar('state', { length: 100 }),
  zipCode: varchar('zip_code', { length: 20 }),
  country: varchar('country', { length: 100 }),
  placeId: varchar('place_id', { length: 100 }),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
