import type pg from 'pg';
import { buildCatalog, readCatalog } from '../modules/pricing/catalog.js';

/** Seed only the bundled supplier catalog; never reads a local database dump. */
export async function seedPricingCatalog(pool: pg.Pool) {
  const catalog = readCatalog();
  const built = buildCatalog(catalog);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('repairebel-pricing-import'))");
    for (let index = 0; index < catalog.rows.length; index += 200) {
      const rows = catalog.rows.slice(index, index + 200);
      await client.query(`INSERT INTO repair_price_sources (catalog_version,source_id,source) VALUES ${rows.map((_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3}::jsonb)`).join(',')} ON CONFLICT DO NOTHING`, rows.flatMap((row) => [built.version, row.sourceId, JSON.stringify(row)]));
    }
    const ids = new Map<string, string>();
    const models = [...new Map(built.prices.map((price) => [price.modelId, price])).values()];
    for (let index = 0; index < models.length; index += 200) {
      const batch = models.slice(index, index + 200);
      // Preserve existing IDs referenced by store inventory. Resolve UUIDs from
      // the upsert result instead of replacing old device rows.
      const result = await client.query(`INSERT INTO device_models (id,brand,model_name,device_type,model_number) VALUES ${batch.map((_, i) => `($${i * 5 + 1},$${i * 5 + 2},$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5})`).join(',')} ON CONFLICT (brand,model_name) DO UPDATE SET device_type=EXCLUDED.device_type,model_number=EXCLUDED.model_number RETURNING id,brand,model_name`, batch.flatMap((price) => [price.modelId, price.brand, price.model, price.deviceType, price.modelNumber]));
      for (const row of result.rows) ids.set(`${row.brand}|${row.model_name}`, row.id);
    }
    await client.query('UPDATE repair_prices SET active=false WHERE active=true');
    for (let index = 0; index < built.prices.length; index += 150) {
      const batch = built.prices.slice(index, index + 150);
      const values = batch.flatMap((price) => {
        const id = ids.get(`${price.brand}|${price.model}`);
        if (!id) throw new Error('Imported model ID was not resolved');
        return [id, price.issueType, price.category, price.partsCost, price.markupMultiplier, price.laborFeeCents, price.suggestedPriceCents, built.version, JSON.stringify({ ...price.snapshot, deviceModelId: id })];
      });
      await client.query(`INSERT INTO repair_prices (device_model_id,issue_type,category,parts_cost,markup_multiplier,labor_fee_cents,suggested_price_cents,catalog_version,snapshot) VALUES ${batch.map((_, i) => `(${Array.from({ length: 9 }, (_, j) => `$${i * 9 + j + 1}`).join(',')})`).join(',')} ON CONFLICT (device_model_id,issue_type) DO UPDATE SET category=EXCLUDED.category,parts_cost=EXCLUDED.parts_cost,markup_multiplier=EXCLUDED.markup_multiplier,labor_fee_cents=EXCLUDED.labor_fee_cents,suggested_price_cents=EXCLUDED.suggested_price_cents,catalog_version=EXCLUDED.catalog_version,snapshot=EXCLUDED.snapshot,active=true,updated_at=now()`, values);
    }
    await client.query('COMMIT');
    console.log(`Imported ${built.sourceCount} source rows and ${built.prices.length} suggested prices into the configured database.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
