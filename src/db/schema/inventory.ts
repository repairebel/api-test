import {
  pgTable,
  uuid,
  varchar,
  integer,
  text,
  timestamp,
  pgEnum,
  unique,
  index,
} from 'drizzle-orm/pg-core';

export const inventoryMovementTypeEnum = pgEnum('inventory_movement_type', [
  'RESERVED',
  'RELEASED',
  'USED',
  'ADJUSTMENT',
  'RESTOCK',
  'STOCK_IN',
  'STOCK_OUT',
]);

export const deviceModels = pgTable('device_models', {
  id: uuid('id').primaryKey().defaultRandom(),
  brand: varchar('brand', { length: 100 }).notNull(),
  deviceType: varchar('device_type', { length: 50 }).notNull().default('Smartphone'),
  modelName: varchar('model_name', { length: 255 }).notNull(),
  modelNumber: varchar('model_number', { length: 150 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('device_models_brand_model_name_key').on(t.brand, t.modelName),
  index('idx_device_models_brand').on(t.brand),
]);

export const inventoryItems = pgTable('inventory_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id').notNull(),
  deviceModelId: uuid('device_model_id').references(() => deviceModels.id),
  deviceModel: varchar('device_model', { length: 255 }).notNull(),
  deviceBrand: varchar('device_brand', { length: 100 }).notNull(),
  modelNumber: varchar('model_number', { length: 150 }),
  partType: varchar('part_type', { length: 200 }).notNull(),
  quality: varchar('quality', { length: 50 }).notNull(),   // AFTERMARKET|PREMIUM|ORIGINAL
  condition: varchar('condition', { length: 50 }).notNull().default('new'),
  quantity: integer('quantity').notNull().default(0),
  quantityReserved: integer('quantity_reserved').notNull().default(0),
  costPriceCents: integer('cost_price_cents').notNull().default(0),
  sellPriceCents: integer('sell_price_cents').notNull().default(0),
  lowStockThreshold: integer('low_stock_threshold').notNull().default(5),
  supplier: varchar('supplier', { length: 255 }),
  warrantyDays: integer('warranty_days').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('inventory_items_shop_model_part_quality_condition_uniq').on(
    t.shopId, t.deviceModel, t.partType, t.quality, t.condition,
  ),
  index('idx_inventory_items_shop_id').on(t.shopId),
]);

export const inventoryMovements = pgTable('inventory_movements', {
  id: uuid('id').primaryKey().defaultRandom(),
  inventoryItemId: uuid('inventory_item_id')
    .notNull()
    .references(() => inventoryItems.id, { onDelete: 'cascade' }),
  type: inventoryMovementTypeEnum('type').notNull(),
  quantity: integer('quantity').notNull(),
  note: text('note'),
  referenceId: uuid('reference_id'), // offerId, jobId, etc.
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_inventory_movements_item_id').on(t.inventoryItemId, t.createdAt),
]);
