import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  pgEnum,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { requests } from './requests.js';
import { shops } from './shops.js';

export const offerStatusEnum = pgEnum('offer_status', [
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'WITHDRAWN',
]);

export const partsQualityEnum = pgEnum('parts_quality', [
  'AFTERMARKET',
  'PREMIUM',
  'ORIGINAL',
]);

export const offers = pgTable(
  'offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    priceCents: integer('price_cents').notNull(),
    etaMinutes: integer('eta_minutes').notNull(),
    warrantyDays: integer('warranty_days').notNull().default(0),
    partsQuality: partsQualityEnum('parts_quality').notNull().default('AFTERMARKET'),
    note: text('note'),
    status: offerStatusEnum('status').notNull().default('PENDING'),
    reserveInventoryItemId: uuid('reserve_inventory_item_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('offers_request_shop_idx').on(table.requestId, table.shopId),
  ],
);
