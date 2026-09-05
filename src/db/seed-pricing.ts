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
      // Preserve existing IDs referenced by store inventory. Admin-edited
      // models are identified by their stable catalog ID and are never
      // overwritten by a later catalog deployment.
      const existing = await client.query(
        'SELECT id, brand, model_name, is_admin_override FROM device_models WHERE id = ANY($1::uuid[])',
        [batch.map((price) => price.modelId)],
      );
      const existingIds = new Set(existing.rows.map((row) => row.id));
      for (const row of existing.rows) ids.set(`${row.brand}|${row.model_name}`, row.id);
      for (const price of batch) {
        if (existingIds.has(price.modelId)) ids.set(`${price.brand}|${price.model}`, price.modelId);
      }
      const mutableExisting = existing.rows.filter((row) => !row.is_admin_override)
        .map((row) => batch.find((price) => price.modelId === row.id)).filter(Boolean);
      if (mutableExisting.length > 0) {
        const values = mutableExisting.flatMap((price) => [price!.modelId, price!.brand, price!.model, price!.deviceType, price!.modelNumber]);
        await client.query(`UPDATE device_models AS d SET brand=v.brand,model_name=v.model_name,device_type=v.device_type,model_number=v.model_number
          FROM (VALUES ${mutableExisting.map((_, i) => `($${i * 5 + 1}::uuid,$${i * 5 + 2},$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5})`).join(',')}) AS v(id,brand,model_name,device_type,model_number)
          WHERE d.id=v.id AND d.is_admin_override=false`, values);
      }
      const newModels = batch.filter((price) => !existingIds.has(price.modelId));
      if (newModels.length > 0) {
        const result = await client.query(
          `INSERT INTO device_models (id,brand,model_name,device_type,model_number) VALUES ${newModels.map((_, i) => `($${i * 5 + 1},$${i * 5 + 2},$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5})`).join(',')}
           ON CONFLICT (brand,model_name) DO UPDATE SET device_type=EXCLUDED.device_type,model_number=EXCLUDED.model_number
             WHERE device_models.is_admin_override = false
           RETURNING id,brand,model_name`,
          newModels.flatMap((price) => [price.modelId, price.brand, price.model, price.deviceType, price.modelNumber]),
        );
        for (const row of result.rows) ids.set(`${row.brand}|${row.model_name}`, row.id);
        // A conflict with an existing admin-edited row returns no row. Resolve
        // those catalog keys to the existing row without changing its values.
        for (const price of newModels) {
          if (!ids.has(`${price.brand}|${price.model}`)) {
            const [row] = (await client.query(
              'SELECT id, brand, model_name FROM device_models WHERE brand = $1 AND model_name = $2 LIMIT 1',
              [price.brand, price.model],
            )).rows;
            if (row) ids.set(`${row.brand}|${row.model_name}`, row.id);
          }
        }
      }
    }
    // Catalog rows that are not admin overrides are refreshed below. Custom
    // admin rows and edited catalog rows remain active across deployments.
    await client.query('UPDATE repair_prices SET active=false WHERE active=true AND is_admin_override=false');
    for (let index = 0; index < built.prices.length; index += 150) {
      const batch = built.prices.slice(index, index + 150);
      const values = batch.flatMap((price) => {
        const id = ids.get(`${price.brand}|${price.model}`);
        if (!id) throw new Error('Imported model ID was not resolved');
        return [id, price.issueType, price.category, price.partsCost, price.markupMultiplier, price.laborFeeCents, price.suggestedPriceCents, built.version, false, JSON.stringify({ ...price.snapshot, deviceModelId: id })];
      });
      await client.query(`INSERT INTO repair_prices (device_model_id,issue_type,category,parts_cost,markup_multiplier,labor_fee_cents,suggested_price_cents,catalog_version,is_admin_override,snapshot) VALUES ${batch.map((_, i) => `(${Array.from({ length: 10 }, (_, j) => `$${i * 10 + j + 1}`).join(',')})`).join(',')}
        ON CONFLICT (device_model_id,issue_type) DO UPDATE SET category=EXCLUDED.category,parts_cost=EXCLUDED.parts_cost,markup_multiplier=EXCLUDED.markup_multiplier,labor_fee_cents=EXCLUDED.labor_fee_cents,suggested_price_cents=EXCLUDED.suggested_price_cents,catalog_version=EXCLUDED.catalog_version,snapshot=EXCLUDED.snapshot,active=true,updated_at=now()
        WHERE repair_prices.is_admin_override = false`, values);
    }
    await client.query('COMMIT');
    console.log(`Imported ${built.sourceCount} source rows and ${built.prices.length} suggested prices into the configured database.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
