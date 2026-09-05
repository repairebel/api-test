import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { calculateSuggestedPriceCents, issueId, median } from './pricing-math.js';

export interface CatalogRow {
  sourceId: number; category: string; brand: string; deviceType: string;
  model: string; modelId: string; repairType: string; difficulty: string;
  modelNumber?: string; deviceFamily?: string; deviceVariant?: string; partsCategory?: string;
  partsCost: number; markupMultiplier: number; laborFee: number;
  catalogEligible: boolean;
  compatibleModels?: Array<{ model: string; modelId: string }>;
  [key: string]: unknown;
}
export interface Catalog {
  version: string | number; sourceWorkbook: string; sourceSha256: string; currency: 'USD';
  laborFees: Record<string, number>; rows: CatalogRow[];
}

export function readCatalog(): Catalog {
  return JSON.parse(readFileSync(new URL('./catalog-data.json', import.meta.url), 'utf8'));
}

export function buildCatalog(catalog: Catalog) {
  if (catalog.currency !== 'USD' || !catalog.rows.length) throw new Error('Expected a populated USD catalog');
  // Version the interpreted data as well as the workbook so normalization changes
  // invalidate old quotes even when the source XLSX has not changed.
  const version = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
  const sourceIds = new Set<number>();
  const groups = new Map<string, { model: CatalogRow; rows: CatalogRow[] }>();
  for (const row of catalog.rows) {
    if (!Number.isInteger(row.sourceId) || sourceIds.has(row.sourceId)) throw new Error('Duplicate/invalid source row ID');
    sourceIds.add(row.sourceId);
    if (!row.catalogEligible) continue;
    if (!row.brand || !row.model || !row.modelId || !row.repairType || row.model.length > 255 || issueId(row.repairType).length > 50) throw new Error(`Invalid model or repair in row ${row.sourceId}`);
    if (catalog.laborFees[row.difficulty] !== row.laborFee) throw new Error(`Labor tier mismatch in row ${row.sourceId}`);
    if (row.markupMultiplier !== 2 || row.laborFee !== 30) throw new Error(`Expected 2x parts plus fixed $30 labor in row ${row.sourceId}`);
    calculateSuggestedPriceCents(row.partsCost, row.markupMultiplier, Math.round(row.laborFee * 100));
    const models = row.compatibleModels?.length ? row.compatibleModels : [{ model: row.model, modelId: row.modelId }];
    for (const model of models) {
      const key = `${model.modelId}|${issueId(row.repairType)}`;
      const group = groups.get(key) ?? { model: { ...row, ...model }, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }
  }
  const prices = [...groups.values()].map(({ model, rows }) => {
    if (new Set(rows.map((row) => row.markupMultiplier)).size !== 1) {
      throw new Error(`Conflicting markup policies for ${model.model} ${model.repairType}`);
    }
    // Source values are already medians. This is deliberately an unweighted
    // median of eligible row medians, not a claimed median of raw supplier SKUs.
    const partsCost = median(rows.map((row) => row.partsCost));
    // A corrected repair label may merge source rows with different tiers.
    // Keep the highest recorded labor fee rather than silently lowering the floor.
    const laborFeeCents = Math.round(Math.max(...rows.map((row) => row.laborFee)) * 100);
    const suggestedPriceCents = calculateSuggestedPriceCents(partsCost, model.markupMultiplier, laborFeeCents);
    return {
      modelId: model.modelId, brand: model.brand, model: model.model, deviceType: model.deviceType,
      modelNumber: model.modelNumber ?? null,
      category: model.category, issueType: issueId(model.repairType), partsCost,
      markupMultiplier: model.markupMultiplier, laborFeeCents, suggestedPriceCents,
      snapshot: {
        catalogVersion: version, currency: 'USD' as const, deviceModelId: model.modelId,
        deviceBrand: model.brand, deviceModel: model.model, issueType: issueId(model.repairType),
        deviceModelNumber: model.modelNumber, deviceFamily: model.deviceFamily,
        deviceVariant: model.deviceVariant, partsCategory: model.partsCategory,
        issueDisplayName: model.repairType, partsCost, partsCostCents: partsCost * 100,
        markupMultiplier: model.markupMultiplier, laborFeeCents, suggestedPriceCents,
        sourceRowIds: rows.map((row) => row.sourceId).sort((a, b) => a - b),
        sourceWorkbook: catalog.sourceWorkbook, sourceSha256: catalog.sourceSha256,
        originalSourceRowIds: [...new Set(rows.flatMap(row => (row.originalSourceRowIds as number[] | undefined) ?? []))].sort((a,b) => a-b),
        aggregation: 'median of eligible supplier row medians per individual device and repair variant; fixed $30 labor',
      },
    };
  });
  if (!prices.length) throw new Error('No eligible prices; refusing to deactivate the existing catalog');
  return { version, prices, sourceCount: catalog.rows.length, modelCount: new Set(prices.map((price) => price.modelId)).size };
}
