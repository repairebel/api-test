import { createHash, randomUUID } from 'node:crypto';
import { pool } from '../../db/client.js';
import type { PriceSnapshot } from '../../db/schema/repair-prices.js';
import { readCatalog } from './catalog.js';
import { BEDROCK_MODEL_ID, PRICING_PROMPT_VERSION, predictBedrockPrice } from './bedrock-pricing.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';

const datasetVersion = createHash('sha256').update(JSON.stringify(readCatalog())).digest('hex');
export const bedrockPriceProvider = { predict: predictBedrockPrice };

// A bounded local estimate keeps the customer flow usable during a Bedrock
// outage/rate limit. It is derived only from the harvested catalog and uses
// the same required floor formula; the snapshot clearly identifies it as a
// fallback so it can be replaced by Bedrock after the cache expires.
function fallbackPartsCost(rows: Array<{ parts_cost: string | number }>, issueType: string): number {
  const costs = rows.map((row) => Number(row.parts_cost)).filter((value) => Number.isFinite(value) && value > 0);
  const defaults: Record<string, number> = {
    SCREEN: 55, INNER_SCREEN: 120, OUTER_SCREEN: 70, BATTERY: 28,
    CHARGING_PORT: 24, FRONT_CAMERA: 38, REAR_CAMERA: 65,
    REAR_TELEPHOTO_CAMERA: 70, REAR_ULTRA_WIDE_CAMERA: 55,
    REAR_MACRO_CAMERA: 35, CAMERA: 55, CAMERA_LENS: 20,
    BACK_GLASS: 35, HOUSING: 60, BUTTONS_FLEX: 22, MICROPHONE: 18,
    MOTHERBOARD_IC: 75, SIM_TRAY: 15, SPEAKER: 22, VIBRATION_MOTOR: 20,
  };
  if (costs.length === 0) return defaults[issueType] ?? 35;
  costs.sort((a, b) => a - b);
  const middle = Math.floor(costs.length / 2);
  const median = costs.length % 2 ? costs[middle] : (costs[middle - 1] + costs[middle]) / 2;
  return Math.max(1, Math.round(median * 100) / 100);
}

export async function getGeneratedQuote(device: {id:string;brand:string;modelName:string;deviceType:string},
  repair: {issueType:string;label:string;customPartName?:string}): Promise<PriceSnapshot> {
  const key = createHash('sha256').update(JSON.stringify([datasetVersion, PRICING_PROMPT_VERSION,
    BEDROCK_MODEL_ID, process.env.AWS_REGION || 'us-east-1', device.id, device.brand, device.modelName,
    device.deviceType, repair.issueType, repair.customPartName?.toLowerCase() ?? ''])).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cached = await client.query(`SELECT snapshot FROM generated_repair_quotes
      WHERE cache_key=$1 AND expires_at>now()
        AND ((snapshot->>'pricingSource') IS DISTINCT FROM 'fallback' OR created_at>now()-interval '15 minutes')`,[key]);
    if (cached.rows[0]) { await client.query('COMMIT'); return cached.rows[0].snapshot; }
    // Only one process may generate this device/part price at a time. Do not hold
    // additional connections waiting for a slow upstream model.
    const lock = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[key]);
    if (!lock.rows[0].acquired) throw new AppError(503, ErrorCode.CONFLICT, 'This suggested price is being prepared. Please try again shortly.');
    const recheck = await client.query(`SELECT snapshot FROM generated_repair_quotes
      WHERE cache_key=$1 AND expires_at>now()
        AND ((snapshot->>'pricingSource') IS DISTINCT FROM 'fallback' OR created_at>now()-interval '15 minutes')`,[key]);
    if (recheck.rows[0]) { await client.query('COMMIT'); return recheck.rows[0].snapshot; }
    const references = await client.query(`SELECT d.brand,d.model_name,p.issue_type,p.parts_cost
      FROM repair_prices p JOIN device_models d ON d.id=p.device_model_id
      WHERE p.active AND (p.device_model_id=$1 OR (p.issue_type=$2 AND d.brand=$3))
      ORDER BY (p.device_model_id=$1) DESC, d.model_name,p.issue_type LIMIT 24`,[device.id,repair.issueType,device.brand]);
    let price;
    let pricingSource: PriceSnapshot['pricingSource'] = 'bedrock';
    try {
      price = await bedrockPriceProvider.predict({device:{brand:device.brand,model:device.modelName,type:device.deviceType},
        repair:{category:repair.issueType,partName:repair.customPartName ?? repair.label},
        referencePartsCosts:references.rows,currency:'USD',laborFeeUsd:30,markupMultiplier:2});
    } catch (error) {
      // Bedrock can be temporarily throttled or unconfigured. Use comparable
      // harvested costs so the minimum price is still enforceable, and log the
      // provider error for Railway diagnostics without exposing credentials.
      console.error('[pricing] Bedrock unavailable; using catalog fallback', error instanceof Error ? error.message : error);
      const partsCost = fallbackPartsCost(references.rows, repair.issueType);
      const partsCostCents = Math.round(partsCost * 100);
      price = { partsCost, suggestedPriceCents: Math.ceil((partsCostCents * 2 + 3000) / 100) * 100 };
      pricingSource = 'fallback';
    }
    if (!price) throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'This part could not be estimated for the selected device. Choose another issue or enter a more specific part name.');
    // Retry a fallback frequently so a temporary Bedrock throttle does not
    // pin a customer to the catalog estimate for a full day.
    const ttlMs = pricingSource === 'fallback' ? 15 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now()+ttlMs).toISOString();
    const snapshot: PriceSnapshot = {
      catalogVersion:createHash('sha256').update(key+randomUUID()).digest('hex'),
      currency:'USD',deviceModelId:device.id,deviceBrand:device.brand,deviceModel:device.modelName,
      issueType:repair.issueType,issueDisplayName:repair.label,customPartName:repair.customPartName,
      partsCost:price.partsCost,partsCostCents:Math.round(price.partsCost*100),markupMultiplier:2,
      laborFeeCents:3000,suggestedPriceCents:price.suggestedPriceCents,sourceRowIds:[],
      sourceWorkbook:'',sourceSha256:datasetVersion,
      aggregation: pricingSource === 'fallback'
        ? 'Catalog fallback while Bedrock is unavailable; ceil(2 × parts + $30) in whole USD'
        : 'AI estimated parts cost; ceil(2 × parts + $30) in whole USD',
      pricingSource,modelId:BEDROCK_MODEL_ID,promptVersion:PRICING_PROMPT_VERSION,expiresAt,
    };
    await client.query(`INSERT INTO generated_repair_quotes(cache_key,snapshot,expires_at) VALUES($1,$2,$3)
      ON CONFLICT(cache_key) DO UPDATE SET snapshot=EXCLUDED.snapshot,expires_at=EXCLUDED.expires_at,created_at=now()`,
      [key,JSON.stringify(snapshot),expiresAt]);
    await client.query('COMMIT');
    return snapshot;
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
