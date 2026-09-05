import { and, eq, exists } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { deviceModels, repairPrices } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { ISSUE_CATEGORIES, parseRepair } from './issue-categories.js';
import { getGeneratedQuote } from './generated-quotes.js';

export function supportedModelCondition() {
  return exists(db.select({ id: repairPrices.deviceModelId }).from(repairPrices).where(and(
    eq(repairPrices.deviceModelId, deviceModels.id), eq(repairPrices.active, true),
  )));
}

export async function getSupportedBrands() {
  const rows = await db.selectDistinct({ brand: deviceModels.brand }).from(deviceModels)
    .where(supportedModelCondition()).orderBy(deviceModels.brand);
  return rows.map((row) => row.brand);
}

export function describeRepair(id: string, label?: string) {
  const name = label ?? id.split('_').map((word) => word === 'IC' || word === 'SIM' ? word : word[0] + word.slice(1).toLowerCase()).join(' ');
  const icon = /SCREEN/.test(id) ? '📱' : /BATTERY/.test(id) ? '🔋' : /CAMERA/.test(id) ? '📷' : /CHARGING/.test(id) ? '🔌' : /SPEAKER|MICROPHONE/.test(id) ? '🔊' : '🔧';
  return { id, name, displayName: name, icon, description: `${name} repair or replacement`, defaultPartType: name };
}

export async function getDatasetIssues(deviceModelId?: string) {
  const rows = deviceModelId ? await db.select({issueType:repairPrices.issueType,suggestedPriceCents:repairPrices.suggestedPriceCents})
    .from(repairPrices).where(and(eq(repairPrices.active,true),eq(repairPrices.deviceModelId,deviceModelId))) : [];
  const prices = new Map(rows.map(row => [row.issueType,row.suggestedPriceCents]));
  return Object.entries(ISSUE_CATEGORIES).map(([id,label]) => ({...describeRepair(id,label),
    ...(prices.has(id) ? {suggestedPriceCents:prices.get(id)} : {}),
    ...(id==='OTHER' ? {description:'Enter a custom part name, up to 10 words.',maxCustomPartWords:10} : {})}));
}

export async function getDatasetQuote(input: {
  deviceModelId: string;
  issueType: string;
  deviceBrand?: string;
  deviceModel?: string;
  customPartName?: string;
}) {
  if (!Object.hasOwn(ISSUE_CATEGORIES,input.issueType)) {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Suggested pricing is unavailable for this repair. Choose a supported repair.');
  }
  let repair;
  try { repair = parseRepair(input.issueType,input.customPartName); }
  catch { throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Choose a valid issue. Others requires a custom part name of 1–10 words (maximum 200 characters).'); }
  const [device] = await db.select().from(deviceModels).where(eq(deviceModels.id,input.deviceModelId)).limit(1);
  if (!device) throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Select an available device model.');
  if ((input.deviceBrand && input.deviceBrand !== device.brand) || (input.deviceModel && input.deviceModel !== device.modelName)) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'The device details do not match the selected model.');
  }
  const [row] = await db.select({ price: repairPrices, device: deviceModels }).from(repairPrices)
    .innerJoin(deviceModels, eq(repairPrices.deviceModelId, deviceModels.id))
    .where(and(eq(repairPrices.deviceModelId, input.deviceModelId), eq(repairPrices.issueType, input.issueType), eq(repairPrices.active, true))).limit(1);
  if (!row) {
    const snapshot = await getGeneratedQuote(device,repair);
    return {...snapshot,minPriceCents:snapshot.suggestedPriceCents,suggestedOfferCents:snapshot.suggestedPriceCents,
      source:'bedrock' as const,priceSnapshot:snapshot};
  }
  // Do not let a cheap model ID be submitted with a different, more expensive device label.
  if ((input.deviceBrand && input.deviceBrand !== row.device.brand) || (input.deviceModel && input.deviceModel !== row.device.modelName)) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'The device details do not match the selected catalog model. Please select your device again.');
  }
  const snapshot = { ...row.price.snapshot, pricingSource:'dataset' as const, deviceModelId: row.device.id, deviceBrand: row.device.brand, deviceModel: row.device.modelName };
  return {
    ...snapshot,
    minPriceCents: row.price.suggestedPriceCents,
    suggestedPriceCents: row.price.suggestedPriceCents,
    suggestedOfferCents: row.price.suggestedPriceCents,
    source: 'dataset' as const,
    priceSnapshot: snapshot,
  };
}

export function assertCustomerPrice(offerCents: number, quote: { suggestedPriceCents: number; catalogVersion: string }, catalogVersion?: string) {
  if (catalogVersion && catalogVersion !== quote.catalogVersion) {
    throw new AppError(409, ErrorCode.CONFLICT, 'Suggested pricing has changed. Review the updated price before sending your request.', { suggestedPriceCents: quote.suggestedPriceCents, catalogVersion: quote.catalogVersion });
  }
  if (!Number.isSafeInteger(offerCents) || offerCents < quote.suggestedPriceCents || offerCents > 2147483647) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, `Your offer must be at least the suggested price ($${(quote.suggestedPriceCents / 100).toFixed(2)}).`, { suggestedPriceCents: quote.suggestedPriceCents });
  }
}
