import 'dotenv/config';
import assert from 'node:assert/strict';
import pg from 'pg';
import {buildCatalog, readCatalog} from '../src/modules/pricing/catalog.js';
import {getPgConnectionConfig} from '../src/lib/postgres-config.js';
import {assertTestDatabase} from '../src/scripts/test-database-guard.js';

const url=process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
assertTestDatabase(url);
const built=buildCatalog(readCatalog());
const pool=new pg.Pool({...getPgConnectionConfig(url),connectionTimeoutMillis:10000});
try {
  const {rows}=await pool.query(`SELECT d.brand,d.model_name,d.model_number,
    p.issue_type,p.parts_cost,p.markup_multiplier,p.labor_fee_cents,
    p.suggested_price_cents,p.catalog_version,p.snapshot
    FROM repair_prices p JOIN device_models d ON d.id=p.device_model_id WHERE p.active`);
  assert.equal(rows.length,built.prices.length);
  const expected=new Map(built.prices.map(p=>[`${p.brand}|${p.model}|${p.issueType}`,p]));
  for (const row of rows) {
    const price=expected.get(`${row.brand}|${row.model_name}|${row.issue_type}`);
    assert.ok(price,'Unexpected active device/repair');
    assert.equal(row.model_number,price.modelNumber);
    assert.equal(Number(row.parts_cost),price.partsCost);
    assert.equal(Number(row.markup_multiplier),2);
    assert.equal(row.labor_fee_cents,3000);
    assert.equal(row.suggested_price_cents,price.suggestedPriceCents);
    assert.equal(row.snapshot.suggestedPriceCents,price.suggestedPriceCents);
    assert.equal(row.catalog_version,built.version);
  }
  const archived=await pool.query('SELECT count(*)::int AS count FROM repair_price_sources WHERE catalog_version=$1',[built.version]);
  assert.equal(archived.rows[0].count,built.sourceCount);
  console.log(JSON.stringify({verified:true,prices:rows.length,models:built.modelCount,
    formula:'2 × parts cost + $30; rounded upward to cents',catalogVersion:built.version}));
} finally {await pool.end();}
