import { eq, and, or, ilike, desc, count } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { deviceModels } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';

function cleanModelValue(value: string | undefined, field: string, max: number) {
  if (value === undefined) return undefined;
  const cleaned = value.trim().replace(/\s+/gu, ' ');
  if (!cleaned || cleaned.length > max) throw new AppError(400, ErrorCode.VALIDATION_ERROR, `${field} is required and must be ${max} characters or fewer`);
  return cleaned;
}

interface ListDeviceModelsQuery {
  page?: number;
  limit?: number;
  search?: string;
  brand?: string;
}

export async function listDeviceModels(query: ListDeviceModelsQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 50;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (query.brand) conditions.push(eq(deviceModels.brand, query.brand));
  if (query.search) {
    conditions.push(
      or(
        ilike(deviceModels.modelName, `%${query.search}%`),
        ilike(deviceModels.brand, `%${query.search}%`),
        ilike(deviceModels.modelNumber, `%${query.search}%`),
      ),
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(deviceModels).where(where).orderBy(desc(deviceModels.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(deviceModels).where(where),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

export async function getDeviceModel(modelId: string) {
  const [model] = await db.select().from(deviceModels).where(eq(deviceModels.id, modelId)).limit(1);
  if (!model) throw new AppError(404, ErrorCode.NOT_FOUND, 'Device model not found');
  return { ...model, createdAt: model.createdAt?.toISOString() ?? null };
}

export async function createDeviceModel(data: {
  brand: string;
  deviceType: string;
  modelName: string;
  modelNumber?: string;
}) {
  const values = {
    brand: cleanModelValue(data.brand, 'Brand', 100)!,
    deviceType: cleanModelValue(data.deviceType, 'Device type', 50)!,
    modelName: cleanModelValue(data.modelName, 'Model name', 255)!,
    modelNumber: data.modelNumber ? cleanModelValue(data.modelNumber, 'Model number', 150) : undefined,
    isAdminOverride: true,
  };
  const [model] = await db.insert(deviceModels).values(values).returning();
  return { ...model, createdAt: model.createdAt?.toISOString() ?? null };
}

export async function updateDeviceModel(
  modelId: string,
  data: Partial<{ brand: string; deviceType: string; modelName: string; modelNumber: string }>,
) {
  const [existing] = await db.select({ id: deviceModels.id }).from(deviceModels).where(eq(deviceModels.id, modelId)).limit(1);
  if (!existing) throw new AppError(404, ErrorCode.NOT_FOUND, 'Device model not found');

  const update = {
    ...(data.brand !== undefined ? { brand: cleanModelValue(data.brand, 'Brand', 100) } : {}),
    ...(data.deviceType !== undefined ? { deviceType: cleanModelValue(data.deviceType, 'Device type', 50) } : {}),
    ...(data.modelName !== undefined ? { modelName: cleanModelValue(data.modelName, 'Model name', 255) } : {}),
    ...(data.modelNumber !== undefined ? { modelNumber: cleanModelValue(data.modelNumber, 'Model number', 150) } : {}),
    isAdminOverride: true,
  };
  if (Object.keys(update).length === 1) throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Provide at least one model field to update');
  const [model] = await db
    .update(deviceModels)
    .set(update)
    .where(eq(deviceModels.id, modelId))
    .returning();

  return { ...model, createdAt: model.createdAt?.toISOString() ?? null };
}

export async function deleteDeviceModel(modelId: string) {
  const [existing] = await db.select({ id: deviceModels.id }).from(deviceModels).where(eq(deviceModels.id, modelId)).limit(1);
  if (!existing) throw new AppError(404, ErrorCode.NOT_FOUND, 'Device model not found');
  await db.delete(deviceModels).where(eq(deviceModels.id, modelId));
  return { message: 'Device model deleted', modelId };
}
