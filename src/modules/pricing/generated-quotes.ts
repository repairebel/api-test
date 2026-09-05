import { createHash, randomUUID } from 'node:crypto';
import { pool } from '../../db/client.js';
import type { PriceSnapshot } from '../../db/schema/repair-prices.js';
import { readCatalog } from './catalog.js';
import { BEDROCK_MODEL_ID, PRICING_PROMPT_VERSION, predictBedrockPrice } from './bedrock-pricing.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';

const datasetVersion = createHash('sha256').update(JSON.stringify(readCatalog())).digest('hex');
export const bedrockPriceProvider = { predict: predictBedrockPrice };

export async function getGeneratedQuote(device: {id:string;brand:string;modelName:string;deviceType:string},
  repair: {issueType:string;label:string;customPartName?:string}): Promise<PriceSnapshot> {
  const key = createHash('sha256').update(JSON.stringify([datasetVersion, PRICING_PROMPT_VERSION,
    BEDROCK_MODEL_ID, process.env.AWS_REGION || 'us-east-1', device.id, device.brand, device.modelName,
    device.deviceType, repair.issueType, repair.customPartName?.toLowerCase() ?? ''])).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cached = await client.query('SELECT snapshot FROM generated_repair_quotes WHERE cache_key=$1 AND expires_at>now()',[key]);
    if (cached.rows[0]) { await client.query('COMMIT'); return cached.rows[0].snapshot; }
    // Only one process may generate this device/part price at a time. Do not hold
    // additional connections waiting for a slow upstream model.
    const lock = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[key]);
    if (!lock.rows[0].acquired) throw new AppError(503, ErrorCode.CONFLICT, 'This suggested price is being prepared. Please try again shortly.');
    const recheck = await client.query('SELECT snapshot FROM generated_repair_quotes WHERE cache_key=$1 AND expires_at>now()',[key]);
    if (recheck.rows[0]) { await client.query('COMMIT'); return recheck.rows[0].snapshot; }
    const references = await client.query(`SELECT d.brand,d.model_name,p.issue_type,p.parts_cost
      FROM repair_prices p JOIN device_models d ON d.id=p.device_model_id
      WHERE p.active AND (p.device_model_id=$1 OR (p.issue_type=$2 AND d.brand=$3))
      ORDER BY (p.device_model_id=$1) DESC, d.model_name,p.issue_type LIMIT 24`,[device.id,repair.issueType,device.brand]);
    let price;
    try {
      price = await bedrockPriceProvider.predict({device:{brand:device.brand,model:device.modelName,type:device.deviceType},
        repair:{category:repair.issueType,partName:repair.customPartName ?? repair.label},
        referencePartsCosts:references.rows,currency:'USD',laborFeeUsd:30,markupMultiplier:2});
    } catch {
      throw new AppError(503, ErrorCode.INTERNAL_ERROR, 'AI suggested pricing is temporarily unavailable. Please try again later.');
    }
    if (!price) throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'This part could not be estimated for the selected device. Choose another issue or enter a more specific part name.');
    const expiresAt = new Date(Date.now()+24*60*60*1000).toISOString();
    const snapshot: PriceSnapshot = {
      catalogVersion:createHash('sha256').update(key+randomUUID()).digest('hex'),
      currency:'USD',deviceModelId:device.id,deviceBrand:device.brand,deviceModel:device.modelName,
      issueType:repair.issueType,issueDisplayName:repair.label,customPartName:repair.customPartName,
      partsCost:price.partsCost,partsCostCents:Math.round(price.partsCost*100),markupMultiplier:2,
      laborFeeCents:3000,suggestedPriceCents:price.suggestedPriceCents,sourceRowIds:[],
      sourceWorkbook:'',sourceSha256:datasetVersion,aggregation:'AI estimated parts cost; ceil(2 × parts + $30) in whole USD',
      pricingSource:'bedrock',modelId:BEDROCK_MODEL_ID,promptVersion:PRICING_PROMPT_VERSION,expiresAt,
    };
    await client.query(`INSERT INTO generated_repair_quotes(cache_key,snapshot,expires_at) VALUES($1,$2,$3)
      ON CONFLICT(cache_key) DO UPDATE SET snapshot=EXCLUDED.snapshot,expires_at=EXCLUDED.expires_at,created_at=now()`,
      [key,JSON.stringify(snapshot),expiresAt]);
    await client.query('COMMIT');
    return snapshot;
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
