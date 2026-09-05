import { eq, and, ilike, or, sql, desc, lt, asc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { inventoryItems, inventoryMovements, deviceModels } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';

// ─── Device Model Search ───

export async function searchDeviceModels(opts: {
  brand?: string;
  q?: string;
  deviceType?: string;
  limit?: number;
}) {
  const { brand, q, deviceType, limit = 20 } = opts;
  const conditions: any[] = [];

  if (brand) {
    conditions.push(ilike(deviceModels.brand, brand));
  }
  if (deviceType) {
    conditions.push(ilike(deviceModels.deviceType, deviceType));
  }
  if (q && q.trim().length > 0) {
    conditions.push(ilike(deviceModels.modelName, `%${q.trim()}%`));
  }

  const rows = await db
    .select({
      id: deviceModels.id,
      brand: deviceModels.brand,
      deviceType: deviceModels.deviceType,
      modelName: deviceModels.modelName,
    })
    .from(deviceModels)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(deviceModels.brand), asc(deviceModels.modelName))
    .limit(Math.min(limit, 50));

  return rows;
}

export async function getDeviceModelBrands() {
  const rows = await db
    .selectDistinct({ brand: deviceModels.brand })
    .from(deviceModels)
    .orderBy(asc(deviceModels.brand));

  return rows.map((r) => r.brand);
}

// ─── Helpers ───

function formatItem(row: typeof inventoryItems.$inferSelect) {
  return {
    itemId: row.id,
    deviceModel: row.deviceModel,
    deviceBrand: row.deviceBrand,
    modelNumber: row.modelNumber ?? null,
    partType: row.partType,
    quality: row.quality,
    condition: row.condition,
    qtyOnHand: row.quantity,
    qtyReserved: row.quantityReserved,
    availableQty: row.quantity - row.quantityReserved,
    costPrice: row.costPriceCents,
    sellPrice: row.sellPriceCents,
    supplier: row.supplier ?? null,
    warrantyDays: row.warrantyDays,
    lowStockThreshold: row.lowStockThreshold,
    createdAt: row.createdAt?.toISOString() ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

// ─── List inventory ───

interface ListFilters {
  shopId: string;
  query?: string;
  brand?: string;
  model?: string;
  modelNumber?: string;
  partType?: string;
  quality?: string;
  lowStock?: boolean;
  page: number;
  pageSize: number;
}

export async function listInventory(filters: ListFilters) {
  const { shopId, query, brand, model, modelNumber, partType, quality, lowStock, page, pageSize } = filters;
  const offset = (page - 1) * pageSize;

  const conditions: any[] = [eq(inventoryItems.shopId, shopId)];

  if (query) {
    conditions.push(
      or(
        ilike(inventoryItems.deviceModel, `%${query}%`),
        ilike(inventoryItems.deviceBrand, `%${query}%`),
        ilike(inventoryItems.partType, `%${query}%`),
        ilike(inventoryItems.supplier, `%${query}%`),
      ),
    );
  }
  if (brand) conditions.push(ilike(inventoryItems.deviceBrand, `%${brand}%`));
  if (model) conditions.push(ilike(inventoryItems.deviceModel, `%${model}%`));
  if (modelNumber) conditions.push(ilike(inventoryItems.modelNumber, `%${modelNumber}%`));
  if (partType) conditions.push(ilike(inventoryItems.partType, `%${partType}%`));
  if (quality) conditions.push(eq(inventoryItems.quality, quality.toUpperCase()));
  if (lowStock) {
    conditions.push(
      sql`${inventoryItems.quantity} - ${inventoryItems.quantityReserved} <= ${inventoryItems.lowStockThreshold}`,
    );
  }

  const whereClause = and(...conditions);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(inventoryItems)
    .where(whereClause);

  const rows = await db
    .select()
    .from(inventoryItems)
    .where(whereClause)
    .orderBy(desc(inventoryItems.updatedAt))
    .limit(pageSize)
    .offset(offset);

  return {
    data: rows.map(formatItem),
    total: count,
  };
}

// ─── Get single item ───

export async function getInventoryItem(itemId: string, shopId: string) {
  const [row] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.shopId, shopId)))
    .limit(1);

  if (!row) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Inventory item not found');
  }

  return formatItem(row);
}

// ─── Create item ───

interface CreateItemInput {
  shopId: string;
  brand: string;
  modelName: string;
  modelNumber?: string;
  partType: string;
  quality: string; // AFTERMARKET|PREMIUM|ORIGINAL
  condition: string;
  qtyOnHand: number;
  costPrice: number;       // cents
  sellPrice: number;       // cents
  supplier?: string;
  warrantyDays: number;
  lowStockThreshold: number;
}

export async function createInventoryItem(input: CreateItemInput) {
  const {
    shopId, brand, modelName, modelNumber, partType, quality,
    condition, qtyOnHand, costPrice, sellPrice, supplier, warrantyDays, lowStockThreshold,
  } = input;

  // 1. Upsert device_models
  const [existing] = await db
    .select()
    .from(deviceModels)
    .where(and(eq(deviceModels.brand, brand), eq(deviceModels.modelName, modelName)))
    .limit(1);

  let deviceModelId: string;
  if (existing) {
    deviceModelId = existing.id;
    // Update modelNumber if provided and not already set
    if (modelNumber && !existing.modelNumber) {
      await db
        .update(deviceModels)
        .set({ modelNumber })
        .where(eq(deviceModels.id, deviceModelId));
    }
  } else {
    const [created] = await db
      .insert(deviceModels)
      .values({ brand, modelName, modelNumber: modelNumber ?? null })
      .returning();
    deviceModelId = created.id;
  }

  // 2. Check uniqueness
  const [dup] = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.shopId, shopId),
        eq(inventoryItems.deviceModel, modelName),
        eq(inventoryItems.partType, partType),
        eq(inventoryItems.quality, quality.toUpperCase()),
        eq(inventoryItems.condition, condition),
      ),
    )
    .limit(1);

  if (dup) {
    throw new AppError(
      409,
      ErrorCode.CONFLICT,
      `You already have a ${quality} ${condition} ${partType} for ${brand} ${modelName} in your inventory.`,
    );
  }

  // 3. Insert inventory item
  const [item] = await db
    .insert(inventoryItems)
    .values({
      shopId,
      deviceModelId,
      deviceModel: modelName,
      deviceBrand: brand,
      modelNumber: modelNumber ?? null,
      partType,
      quality: quality.toUpperCase(),
      condition,
      quantity: qtyOnHand,
      quantityReserved: 0,
      costPriceCents: costPrice,
      sellPriceCents: sellPrice,
      lowStockThreshold,
      supplier: supplier ?? null,
      warrantyDays,
    })
    .returning();

  // 4. Create RESTOCK movement
  await db.insert(inventoryMovements).values({
    inventoryItemId: item.id,
    type: 'RESTOCK',
    quantity: qtyOnHand,
    note: 'Initial stock',
  });

  return formatItem(item);
}

// ─── List movements ───

interface MovementFilters {
  itemId: string;
  shopId: string;
  limit: number;
  cursor?: string; // id of last movement (load older)
}

export async function listMovements(filters: MovementFilters) {
  const { itemId, shopId, limit, cursor } = filters;

  // Verify item belongs to shop
  const [item] = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.shopId, shopId)))
    .limit(1);

  if (!item) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Inventory item not found');
  }

  const conditions: any[] = [eq(inventoryMovements.inventoryItemId, itemId)];

  if (cursor) {
    // Get cursor row's createdAt to paginate
    const [cursorRow] = await db
      .select({ createdAt: inventoryMovements.createdAt })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.id, cursor))
      .limit(1);

    if (cursorRow?.createdAt) {
      conditions.push(lt(inventoryMovements.createdAt, cursorRow.createdAt));
    }
  }

  const rows = await db
    .select()
    .from(inventoryMovements)
    .where(and(...conditions))
    .orderBy(desc(inventoryMovements.createdAt))
    .limit(limit + 1); // fetch 1 extra for hasMore

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;

  return {
    data: data.map((m) => ({
      id: m.id,
      type: m.type,
      quantity: m.quantity,
      note: m.note ?? null,
      referenceId: m.referenceId ?? null,
      createdAt: m.createdAt?.toISOString() ?? null,
    })),
    hasMore,
    nextCursor: hasMore ? data[data.length - 1].id : null,
  };
}

// ─── Stock In ───

export async function stockIn(itemId: string, shopId: string, qty: number, note?: string) {
  if (qty <= 0) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Quantity must be positive');
  }

  const [item] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.shopId, shopId)))
    .limit(1);

  if (!item) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Inventory item not found');
  }

  const newQty = item.quantity + qty;

  const [updated] = await db
    .update(inventoryItems)
    .set({ quantity: newQty, updatedAt: new Date() })
    .where(eq(inventoryItems.id, itemId))
    .returning();

  await db.insert(inventoryMovements).values({
    inventoryItemId: itemId,
    type: 'STOCK_IN',
    quantity: qty,
    note: note ?? null,
  });

  return formatItem(updated);
}

// ─── Stock Out ───

export async function stockOut(itemId: string, shopId: string, qty: number, note?: string) {
  if (qty <= 0) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Quantity must be positive');
  }

  const [item] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.shopId, shopId)))
    .limit(1);

  if (!item) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Inventory item not found');
  }

  const available = item.quantity - item.quantityReserved;
  if (qty > available) {
    throw new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Cannot stock out ${qty} units. Only ${available} available (${item.quantity} on hand, ${item.quantityReserved} reserved).`,
    );
  }

  const newQty = item.quantity - qty;

  const [updated] = await db
    .update(inventoryItems)
    .set({ quantity: newQty, updatedAt: new Date() })
    .where(eq(inventoryItems.id, itemId))
    .returning();

  await db.insert(inventoryMovements).values({
    inventoryItemId: itemId,
    type: 'STOCK_OUT',
    quantity: -qty,
    note: note ?? null,
  });

  return formatItem(updated);
}

// ─── Adjust ───

export async function adjustStock(itemId: string, shopId: string, delta: number, note?: string) {
  if (delta === 0) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Delta must not be zero');
  }

  const [item] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.shopId, shopId)))
    .limit(1);

  if (!item) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Inventory item not found');
  }

  const newQty = item.quantity + delta;

  if (newQty < 0) {
    throw new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Adjustment would bring quantity below 0 (current: ${item.quantity}, delta: ${delta}).`,
    );
  }

  if (newQty < item.quantityReserved) {
    throw new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Adjustment would bring quantity (${newQty}) below reserved amount (${item.quantityReserved}).`,
    );
  }

  const [updated] = await db
    .update(inventoryItems)
    .set({ quantity: newQty, updatedAt: new Date() })
    .where(eq(inventoryItems.id, itemId))
    .returning();

  await db.insert(inventoryMovements).values({
    inventoryItemId: itemId,
    type: 'ADJUSTMENT',
    quantity: delta,
    note: note ?? null,
  });

  return formatItem(updated);
}

// ─── Update pricing ───

export async function updatePricing(
  itemId: string,
  shopId: string,
  costPrice: number,
  sellPrice: number,
) {
  if (costPrice < 0) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Cost price cannot be negative');
  }
  if (sellPrice < 0) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Sell price cannot be negative');
  }

  const [item] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.shopId, shopId)))
    .limit(1);

  if (!item) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Inventory item not found');
  }

  const [updated] = await db
    .update(inventoryItems)
    .set({ costPriceCents: costPrice, sellPriceCents: sellPrice, updatedAt: new Date() })
    .where(eq(inventoryItems.id, itemId))
    .returning();

  return formatItem(updated);
}

// ─── Delete item ───

export async function deleteInventoryItem(itemId: string, shopId: string) {
  const [item] = await db
    .select({ id: inventoryItems.id, quantityReserved: inventoryItems.quantityReserved })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.shopId, shopId)))
    .limit(1);

  if (!item) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Inventory item not found');
  }

  if (item.quantityReserved > 0) {
    throw new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Cannot delete item with ${item.quantityReserved} reserved units. Release reservations first.`,
    );
  }

  await db.delete(inventoryItems).where(eq(inventoryItems.id, itemId));

  return { deleted: true };
}
