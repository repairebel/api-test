import { pgTable, varchar, integer, numeric, boolean, jsonb, timestamp, uuid, primaryKey, index } from 'drizzle-orm/pg-core';
import { deviceModels } from './inventory.js';

// Keep every harvested row, including quarantined rows, for a reproducible audit.
export const repairPriceSources = pgTable('repair_price_sources', {
  catalogVersion: varchar('catalog_version', { length: 100 }).notNull(),
  sourceId: integer('source_id').notNull(),
  source: jsonb('source').$type<Record<string, unknown>>().notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.catalogVersion, t.sourceId] })]);

export interface PriceSnapshot {
  pricingSource?: 'dataset' | 'bedrock';
  customPartName?: string;
  modelId?: string;
  promptVersion?: string;
  expiresAt?: string;
  catalogVersion: string;
  currency: 'USD';
  deviceModelId: string;
  deviceBrand: string;
  deviceModel: string;
  issueType: string;
  issueDisplayName: string;
  partsCost: number;
  partsCostCents: number;
  markupMultiplier: number;
  laborFeeCents: number;
  suggestedPriceCents: number;
  sourceRowIds: number[];
  sourceWorkbook: string;
  sourceSha256: string;
  aggregation: string;
}

export const generatedRepairQuotes = pgTable('generated_repair_quotes', {
  cacheKey: varchar('cache_key', {length:64}).primaryKey(),
  snapshot: jsonb('snapshot').$type<PriceSnapshot>().notNull(),
  expiresAt: timestamp('expires_at', {withTimezone:true}).notNull(),
  createdAt: timestamp('created_at', {withTimezone:true}).notNull().defaultNow(),
}, t => [index('idx_generated_repair_quotes_expiry').on(t.expiresAt)]);

export const repairPrices = pgTable('repair_prices', {
  deviceModelId: uuid('device_model_id').notNull().references(() => deviceModels.id),
  issueType: varchar('issue_type', { length: 50 }).notNull(),
  category: varchar('category', { length: 100 }).notNull(),
  partsCost: numeric('parts_cost', { precision: 14, scale: 4 }).notNull(),
  markupMultiplier: numeric('markup_multiplier', { precision: 8, scale: 4 }).notNull(),
  laborFeeCents: integer('labor_fee_cents').notNull(),
  suggestedPriceCents: integer('suggested_price_cents').notNull(),
  catalogVersion: varchar('catalog_version', { length: 100 }).notNull(),
  active: boolean('active').notNull().default(true),
  snapshot: jsonb('snapshot').$type<PriceSnapshot>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.deviceModelId, t.issueType] }),
  index('idx_repair_prices_active_model').on(t.active, t.deviceModelId),
]);
