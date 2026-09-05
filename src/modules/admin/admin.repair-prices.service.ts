import { and, asc, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { deviceModels, repairPrices } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { ISSUE_CATEGORIES } from '../pricing/issue-categories.js';
import { buildCatalog, readCatalog } from '../pricing/catalog.js';
import { calculateSuggestedPriceCents, issueId } from '../pricing/pricing-math.js';

const customLabelSchema = z.string().trim().min(1).max(100).refine(
  (value) => value.split(/\s+/u).length <= 15,
  'Use at most 15 words for a custom part label.',
);

export const repairPriceInputSchema = z.object({
  issueType: z.string().trim().min(1).max(50).optional(),
  category: z.string().trim().min(1).max(100),
  partsCost: z.coerce.number().finite().min(0.01).max(1_000_000),
  laborFeeCents: z.coerce.number().int().min(0).max(10_000_000),
  markupMultiplier: z.coerce.number().finite().gt(0).max(20).default(2),
  active: z.boolean().default(true),
  customPartName: customLabelSchema.optional(),
});

export type RepairPriceInput = z.infer<typeof repairPriceInputSchema>;

function adminVersion(base: string, modelId: string, issueType: string, input: RepairPriceInput) {
  return createHash('sha256')
    .update(`${base}|admin|${modelId}|${issueType}|${input.partsCost}|${input.laborFeeCents}|${input.markupMultiplier}|${Date.now()}`)
    .digest('hex');
}

function normalizeIssueType(input: RepairPriceInput) {
  const requested = input.issueType?.trim();
  if (requested && Object.hasOwn(ISSUE_CATEGORIES, requested)) return requested;
  if (requested && /^CUSTOM_[A-Z0-9_]{1,43}$/u.test(requested)) return requested;
  if (input.customPartName) {
    return `CUSTOM_${createHash('sha1').update(input.customPartName.toLowerCase()).digest('hex').slice(0, 16).toUpperCase()}`;
  }
  if (requested) {
    const normalized = issueId(requested);
    if (normalized && normalized.length <= 50) return normalized;
  }
  throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Choose a repair category or provide a custom part label.');
}

function serializePrice(row: typeof repairPrices.$inferSelect) {
  return {
    issueType: row.issueType,
    category: row.category,
    partsCost: Number(row.partsCost),
    partsCostCents: Math.round(Number(row.partsCost) * 100),
    markupMultiplier: Number(row.markupMultiplier),
    laborFeeCents: row.laborFeeCents,
    laborFeeUsd: row.laborFeeCents / 100,
    suggestedPriceCents: row.suggestedPriceCents,
    suggestedPriceUsd: row.suggestedPriceCents / 100,
    active: row.active,
    isAdminOverride: row.isAdminOverride,
    catalogVersion: row.catalogVersion,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

export async function listDeviceModelPrices(modelId: string) {
  const [model] = await db.select({ id: deviceModels.id }).from(deviceModels).where(eq(deviceModels.id, modelId)).limit(1);
  if (!model) throw new AppError(404, ErrorCode.NOT_FOUND, 'Device model not found');
  const rows = await db.select().from(repairPrices)
    .where(eq(repairPrices.deviceModelId, modelId))
    .orderBy(asc(repairPrices.category), asc(repairPrices.issueType));
  return rows.map(serializePrice);
}

export async function createDeviceModelPrice(modelId: string, input: RepairPriceInput, adminUserId: string) {
  const [model] = await db.select().from(deviceModels).where(eq(deviceModels.id, modelId)).limit(1);
  if (!model) throw new AppError(404, ErrorCode.NOT_FOUND, 'Device model not found');
  const parsed = repairPriceInputSchema.parse(input);
  const normalizedIssueType = normalizeIssueType(parsed);
  const [existing] = await db.select({ issueType: repairPrices.issueType })
    .from(repairPrices)
    .where(and(eq(repairPrices.deviceModelId, modelId), eq(repairPrices.issueType, normalizedIssueType)))
    .limit(1);
  if (existing) throw new AppError(409, ErrorCode.CONFLICT, 'A price for this repair already exists. Edit the existing row instead.');

  const catalogVersion = adminVersion('admin-new', modelId, normalizedIssueType, parsed);
  const suggestedPriceCents = calculateSuggestedPriceCents(parsed.partsCost, parsed.markupMultiplier, parsed.laborFeeCents);
  const snapshot = {
    pricingSource: 'admin' as const,
    catalogVersion,
    currency: 'USD' as const,
    deviceModelId: modelId,
    deviceBrand: model.brand,
    deviceModel: model.modelName,
    deviceModelNumber: model.modelNumber,
    issueType: normalizedIssueType,
    issueDisplayName: parsed.category,
    customPartName: parsed.customPartName,
    partsCost: parsed.partsCost,
    partsCostCents: parsed.partsCost * 100,
    markupMultiplier: parsed.markupMultiplier,
    laborFeeCents: parsed.laborFeeCents,
    suggestedPriceCents,
    sourceRowIds: [],
    sourceWorkbook: 'Admin panel',
    sourceSha256: '',
    aggregation: `Admin configured price; ${parsed.markupMultiplier}x parts + custom labor fee`,
    adminUserId,
  };
  const [row] = await db.insert(repairPrices).values({
    deviceModelId: modelId,
    issueType: normalizedIssueType,
    category: parsed.category,
    partsCost: String(parsed.partsCost),
    markupMultiplier: String(parsed.markupMultiplier),
    laborFeeCents: parsed.laborFeeCents,
    suggestedPriceCents,
    catalogVersion,
    active: parsed.active,
    isAdminOverride: true,
    snapshot,
  }).returning();
  return serializePrice(row!);
}

export async function updateDeviceModelPrice(
  modelId: string,
  issueType: string,
  input: RepairPriceInput,
  adminUserId: string,
) {
  const [model] = await db.select().from(deviceModels).where(eq(deviceModels.id, modelId)).limit(1);
  if (!model) throw new AppError(404, ErrorCode.NOT_FOUND, 'Device model not found');
  const [existing] = await db.select().from(repairPrices)
    .where(and(eq(repairPrices.deviceModelId, modelId), eq(repairPrices.issueType, issueType)))
    .limit(1);
  if (!existing) throw new AppError(404, ErrorCode.NOT_FOUND, 'Repair price not found');
  const parsed = repairPriceInputSchema.parse({ ...input, issueType });
  const catalogVersion = adminVersion(existing.catalogVersion, modelId, issueType, parsed);
  const suggestedPriceCents = calculateSuggestedPriceCents(parsed.partsCost, parsed.markupMultiplier, parsed.laborFeeCents);
  const snapshot = {
    ...existing.snapshot,
    pricingSource: 'admin' as const,
    catalogVersion,
    deviceModelId: modelId,
    deviceBrand: model.brand,
    deviceModel: model.modelName,
    deviceModelNumber: model.modelNumber,
    issueType,
    issueDisplayName: parsed.category,
    customPartName: parsed.customPartName,
    partsCost: parsed.partsCost,
    partsCostCents: parsed.partsCost * 100,
    markupMultiplier: parsed.markupMultiplier,
    laborFeeCents: parsed.laborFeeCents,
    suggestedPriceCents,
    aggregation: `Admin configured price; ${parsed.markupMultiplier}x parts + custom labor fee`,
    adminUserId,
  };
  const [row] = await db.update(repairPrices).set({
    category: parsed.category,
    partsCost: String(parsed.partsCost),
    markupMultiplier: String(parsed.markupMultiplier),
    laborFeeCents: parsed.laborFeeCents,
    suggestedPriceCents,
    catalogVersion,
    active: parsed.active,
    isAdminOverride: true,
    snapshot,
    updatedAt: new Date(),
  }).where(and(eq(repairPrices.deviceModelId, modelId), eq(repairPrices.issueType, issueType))).returning();
  return serializePrice(row!);
}

export async function deactivateDeviceModelPrice(modelId: string, issueType: string, adminUserId: string) {
  const [existing] = await db.select().from(repairPrices)
    .where(and(eq(repairPrices.deviceModelId, modelId), eq(repairPrices.issueType, issueType)))
    .limit(1);
  if (!existing) throw new AppError(404, ErrorCode.NOT_FOUND, 'Repair price not found');
  const [row] = await db.update(repairPrices).set({
    active: false,
    isAdminOverride: true,
    updatedAt: new Date(),
    snapshot: { ...existing.snapshot, pricingSource: 'admin' as const, adminUserId, active: false },
  }).where(and(eq(repairPrices.deviceModelId, modelId), eq(repairPrices.issueType, issueType))).returning();
  return serializePrice(row!);
}

export async function resetDeviceModelPrice(modelId: string, issueType: string) {
  const [model] = await db.select().from(deviceModels).where(eq(deviceModels.id, modelId)).limit(1);
  if (!model) throw new AppError(404, ErrorCode.NOT_FOUND, 'Device model not found');
  const [existing] = await db.select().from(repairPrices)
    .where(and(eq(repairPrices.deviceModelId, modelId), eq(repairPrices.issueType, issueType)))
    .limit(1);
  if (!existing) throw new AppError(404, ErrorCode.NOT_FOUND, 'Repair price not found');
  const catalog = buildCatalog(readCatalog());
  const canonical = catalog.prices.find((price) => price.brand === model.brand && price.model === model.modelName && price.issueType === issueType);
  if (!canonical) {
    return deactivateDeviceModelPrice(modelId, issueType, 'system-reset');
  }
  const [row] = await db.update(repairPrices).set({
    category: canonical.category,
    partsCost: String(canonical.partsCost),
    markupMultiplier: String(canonical.markupMultiplier),
    laborFeeCents: canonical.laborFeeCents,
    suggestedPriceCents: canonical.suggestedPriceCents,
    catalogVersion: catalog.version.toString(),
    active: true,
    isAdminOverride: false,
    snapshot: { ...canonical.snapshot, deviceModelId: modelId, pricingSource: 'dataset' as const },
    updatedAt: new Date(),
  }).where(and(eq(repairPrices.deviceModelId, modelId), eq(repairPrices.issueType, issueType))).returning();
  return serializePrice(row!);
}
