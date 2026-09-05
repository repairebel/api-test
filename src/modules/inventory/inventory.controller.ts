import { FastifyRequest, FastifyReply } from 'fastify';
import {
  listInventory,
  getInventoryItem,
  createInventoryItem,
  listMovements,
  stockIn,
  stockOut,
  adjustStock,
  updatePricing,
  deleteInventoryItem,
  searchDeviceModels,
  getDeviceModelBrands,
} from './inventory.service.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';
import { getSupportedBrands } from '../pricing/pricing.service.js';

// GET /v1/device-models/search?brand=X&q=Y&deviceType=Z&limit=20
export async function searchDeviceModelsHandler(request: FastifyRequest, reply: FastifyReply) {
  const { brand, q, deviceType, limit = '20' } = request.query as Record<string, string>;
  const results = await searchDeviceModels({
    brand: brand || undefined,
    q: q || undefined,
    deviceType: deviceType || undefined,
    limit: Math.min(50, Math.max(1, parseInt(limit, 10) || 20)),
  });
  return reply.send(successResponse(results));
}

// GET /v1/device-models/brands
export async function getDeviceModelBrandsHandler(request: FastifyRequest, reply: FastifyReply) {
  const { supportedOnly } = request.query as { supportedOnly?: string };
  const brands = supportedOnly === 'true' ? await getSupportedBrands() : await getDeviceModelBrands();
  return reply.send(successResponse(brands));
}

// GET /v1/shops/me/inventory
export async function listInventoryHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const {
    query, brand, model, modelNumber, partType, quality, lowStock,
    page = '1', pageSize = '20',
  } = request.query as Record<string, string>;

  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(50, Math.max(1, parseInt(pageSize, 10) || 20));

  const { data, total } = await listInventory({
    shopId,
    query: query || undefined,
    brand: brand || undefined,
    model: model || undefined,
    modelNumber: modelNumber || undefined,
    partType: partType || undefined,
    quality: quality || undefined,
    lowStock: lowStock === 'true',
    page: p,
    pageSize: ps,
  });

  return reply.send(paginatedResponse(data, { page: p, pageSize: ps, total }));
}

// POST /v1/shops/me/inventory
export async function createInventoryHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const body = request.body as {
    brand: string;
    modelName: string;
    modelNumber?: string;
    partType: string;
    quality: string;
    condition: string;
    qtyOnHand: number;
    costPrice: number;
    sellPrice: number;
    supplier?: string;
    warrantyDays: number;
    lowStockThreshold: number;
  };

  const item = await createInventoryItem({
    shopId,
    brand: body.brand,
    modelName: body.modelName,
    modelNumber: body.modelNumber,
    partType: body.partType,
    quality: body.quality,
    condition: body.condition || 'new',
    qtyOnHand: body.qtyOnHand,
    costPrice: body.costPrice,
    sellPrice: body.sellPrice,
    supplier: body.supplier,
    warrantyDays: body.warrantyDays ?? 0,
    lowStockThreshold: body.lowStockThreshold ?? 5,
  });

  return reply.status(201).send(successResponse(item));
}

// GET /v1/inventory/:itemId
export async function getInventoryHandler(request: FastifyRequest, reply: FastifyReply) {
  const { itemId } = request.params as { itemId: string };
  const shopId = request.user!.shopId;
  const item = await getInventoryItem(itemId, shopId);
  return reply.send(successResponse(item));
}

// GET /v1/inventory/:itemId/movements
export async function listMovementsHandler(request: FastifyRequest, reply: FastifyReply) {
  const { itemId } = request.params as { itemId: string };
  const shopId = request.user!.shopId;
  const { limit = '20', cursor } = request.query as Record<string, string>;
  const l = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));

  const result = await listMovements({
    itemId,
    shopId,
    limit: l,
    cursor: cursor || undefined,
  });

  return reply.send(successResponse(result));
}

// POST /v1/inventory/:itemId/stock-in
export async function stockInHandler(request: FastifyRequest, reply: FastifyReply) {
  const { itemId } = request.params as { itemId: string };
  const shopId = request.user!.shopId;
  const { qty, note } = request.body as { qty: number; note?: string };
  const item = await stockIn(itemId, shopId, qty, note);
  return reply.send(successResponse(item));
}

// POST /v1/inventory/:itemId/stock-out
export async function stockOutHandler(request: FastifyRequest, reply: FastifyReply) {
  const { itemId } = request.params as { itemId: string };
  const shopId = request.user!.shopId;
  const { qty, note } = request.body as { qty: number; note?: string };
  const item = await stockOut(itemId, shopId, qty, note);
  return reply.send(successResponse(item));
}

// POST /v1/inventory/:itemId/adjust
export async function adjustHandler(request: FastifyRequest, reply: FastifyReply) {
  const { itemId } = request.params as { itemId: string };
  const shopId = request.user!.shopId;
  const { delta, note } = request.body as { delta: number; note?: string };
  const item = await adjustStock(itemId, shopId, delta, note);
  return reply.send(successResponse(item));
}

// PATCH /v1/inventory/:itemId/pricing
export async function updatePricingHandler(request: FastifyRequest, reply: FastifyReply) {
  const { itemId } = request.params as { itemId: string };
  const shopId = request.user!.shopId;
  const { costPrice, sellPrice } = request.body as { costPrice: number; sellPrice: number };
  const item = await updatePricing(itemId, shopId, costPrice, sellPrice);
  return reply.send(successResponse(item));
}

// DELETE /v1/inventory/:itemId
export async function deleteInventoryHandler(request: FastifyRequest, reply: FastifyReply) {
  const { itemId } = request.params as { itemId: string };
  const shopId = request.user!.shopId;
  const result = await deleteInventoryItem(itemId, shopId);
  return reply.send(successResponse(result));
}
