import {
  pgTable,
  uuid,
  integer,
  timestamp,
  pgEnum,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { requests } from './requests.js';
import { shops } from './shops.js';

export const dispatchStatusEnum = pgEnum('dispatch_status', [
  'PENDING',
  'SENT',
  'SEEN',
  'OFFERED',
  'ACCEPTED',
  'DECLINED',
  'SKIPPED',
  'EXPIRED',
]);

export const dispatchTargets = pgTable(
  'dispatch_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    distanceKm: integer('distance_km'), // distance in km (integer)
    status: dispatchStatusEnum('status').notNull().default('PENDING'),
    seenAt: timestamp('seen_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    score: integer('score'), // weighted dispatch score
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('dispatch_request_shop_idx').on(table.requestId, table.shopId),
  ],
);
