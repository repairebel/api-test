import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  pgEnum,
  jsonb,
} from 'drizzle-orm/pg-core';
import type { PriceSnapshot } from './repair-prices.js';

export const requestStatusEnum = pgEnum('request_status', [
  'LIVE',
  'DISPATCHING',
  'OFFERED',
  'ACCEPTED',
  'BOOKED',
  'EXPIRED',
  'CANCELLED',
]);

export const requests = pgTable('requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull(), // references customer app users (no FK for now)
  customerName: varchar('customer_name', { length: 255 }).notNull(),
  deviceBrand: varchar('device_brand', { length: 100 }).notNull(),
  deviceModel: varchar('device_model', { length: 255 }).notNull(),
  issueType: varchar('issue_type', { length: 50 }),
  issueDescription: text('issue_description').notNull(),
  photos: jsonb('photos').$type<string[]>().default([]),
  videoUrl: text('video_url'),
  customerOfferCents: integer('customer_offer_cents').notNull(),
  minPriceCents: integer('min_price_cents').notNull(),
  deviceModelId: uuid('device_model_id'),
  priceSnapshot: jsonb('price_snapshot').$type<PriceSnapshot>(),
  latitude: varchar('latitude', { length: 20 }),
  longitude: varchar('longitude', { length: 20 }),
  address: text('address'),
  status: requestStatusEnum('status').notNull().default('LIVE'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
