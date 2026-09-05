import { eq, and, or, ilike, sql, desc, count } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { inventoryItems, inventoryMovements, shops } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';

interface ListInventoryQuery {
  page?: number;
  limit?: number;
  search?: string;
  shopId?: string;
}

export async function listInventory(query: ListInventoryQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (query.shopId) conditions.push(eq(inventoryItems.shopId, query.shopId));
  if (query.search) {
    conditions.push(
      or(
        ilike(inventoryItems.deviceModel, `%${query.search}%`),
        ilike(inventoryItems.deviceBrand, `%${query.search}%`),
        ilike(inventoryItems.partType, `%${query.search}%`),
      ),
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: inventoryItems.id,
        shopId: inventoryItems.shopId,
        shopName: shops.name,
        deviceModel: inventoryItems.deviceModel,
        deviceBrand: inventoryItems.deviceBrand,
        modelNumber: inventoryItems.modelNumber,
        partType: inventoryItems.partType,
        quality: inventoryItems.quality,
        condition: inventoryItems.condition,
        quantity: inventoryItems.quantity,
        quantityReserved: inventoryItems.quantityReserved,
        costPriceCents: inventoryItems.costPriceCents,
        sellPriceCents: inventoryItems.sellPriceCents,
        lowStockThreshold: inventoryItems.lowStockThreshold,
        supplier: inventoryItems.supplier,
        warrantyDays: inventoryItems.warrantyDays,
        createdAt: inventoryItems.createdAt,
      })
      .from(inventoryItems)
      .leftJoin(shops, eq(shops.id, inventoryItems.shopId))
      .where(where)
      .orderBy(desc(inventoryItems.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(inventoryItems).where(where),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

export async function getInventoryItem(itemId: string) {
  const [item] = await db
    .select({
      id: inventoryItems.id,
      shopId: inventoryItems.shopId,
      shopName: shops.name,
      deviceModelId: inventoryItems.deviceModelId,
      deviceModel: inventoryItems.deviceModel,
      deviceBrand: inventoryItems.deviceBrand,
      modelNumber: inventoryItems.modelNumber,
      partType: inventoryItems.partType,
      quality: inventoryItems.quality,
      condition: inventoryItems.condition,
      quantity: inventoryItems.quantity,
      quantityReserved: inventoryItems.quantityReserved,
      costPriceCents: inventoryItems.costPriceCents,
      sellPriceCents: inventoryItems.sellPriceCents,
      lowStockThreshold: inventoryItems.lowStockThreshold,
      supplier: inventoryItems.supplier,
      warrantyDays: inventoryItems.warrantyDays,
      createdAt: inventoryItems.createdAt,
      updatedAt: inventoryItems.updatedAt,
    })
    .from(inventoryItems)
    .leftJoin(shops, eq(shops.id, inventoryItems.shopId))
    .where(eq(inventoryItems.id, itemId))
    .limit(1);

  if (!item) throw new AppError(404, ErrorCode.NOT_FOUND, 'Inventory item not found');

  return {
    ...item,
    createdAt: item.createdAt?.toISOString() ?? null,
    updatedAt: item.updatedAt?.toISOString() ?? null,
  };
}

export async function getInventoryMovements(itemId: string, query: { page?: number; limit?: number }) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 50;
  const offset = (page - 1) * limit;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.inventoryItemId, itemId))
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(inventoryMovements).where(eq(inventoryMovements.inventoryItemId, itemId)),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}
