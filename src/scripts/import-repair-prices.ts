import 'dotenv/config';
import pg from 'pg';
import { seedPricingCatalog } from '../db/seed-pricing.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { buildCatalog, readCatalog } from '../modules/pricing/catalog.js';
import { getPgConnectionConfig } from '../lib/postgres-config.js';
import { assertTestDatabase } from './test-database-guard.js';

const catalog = readCatalog();
const built = buildCatalog(catalog);
console.log(JSON.stringify({ catalogVersion: built.version, sourceRows: built.sourceCount, models: built.modelCount, prices: built.prices.length, apply: process.argv.includes('--apply') }));

if (process.argv.includes('--apply')) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  assertTestDatabase(url);
  const pool = new pg.Pool({ ...getPgConnectionConfig(url), connectionTimeoutMillis: 10000 });
  try {
    if (process.argv.includes('--migrate')) await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL('../../drizzle/', import.meta.url)) });
    await seedPricingCatalog(pool);
  } finally { await pool.end(); }
}
