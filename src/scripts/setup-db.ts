import 'dotenv/config';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { seedPricingCatalog } from '../db/seed-pricing.js';
import { systemSettings } from '../db/schema/system-settings.js';
import { getPgConnectionConfig } from '../lib/postgres-config.js';

const { Client, Pool } = pg;

const SYSTEM_SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

type Flags = {
  migrateOnly: boolean;
  seedOnly: boolean;
  reset: boolean;
  noCreate: boolean;
};

function parseFlags(argv: string[]): Flags {
  const flags = new Set(argv);
  return {
    migrateOnly: flags.has('--migrate-only'),
    seedOnly: flags.has('--seed-only'),
    reset: flags.has('--reset'),
    noCreate: flags.has('--no-create'),
  };
}

function getProjectRoot() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, '../..');
}

function requireDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  return databaseUrl;
}

function getDatabaseName(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!dbName) {
    throw new Error(`DATABASE_URL is missing a database name: ${databaseUrl}`);
  }
  return dbName;
}

function getAdminDatabaseUrl(databaseUrl: string) {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

function quoteIdent(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function ensureDatabaseExists(databaseUrl: string, reset: boolean) {
  const dbName = getDatabaseName(databaseUrl);

  if (reset && (dbName === 'repairrebel' || dbName === 'postgres')) {
    throw new Error(`Refusing to reset database "${dbName}"`);
  }

  const client = new Client(getPgConnectionConfig(getAdminDatabaseUrl(databaseUrl)));
  await client.connect();

  try {
    const existing = await client.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [dbName],
    );

    const exists = existing.rows[0]?.exists ?? false;

    if (reset && exists) {
      console.log(`Resetting database "${dbName}"...`);
      await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [dbName],
      );
      await client.query(`DROP DATABASE ${quoteIdent(dbName)}`);
    }

    if (!exists || reset) {
      console.log(`Creating database "${dbName}"...`);

      try {
        await client.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === '42501') {
          throw new Error(
            `Permission denied to create database "${dbName}". Create it first with a postgres superuser, or rerun setup with --no-create once the database exists.`,
          );
        }

        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

async function ensurePostgresPrereqs(pool: pg.Pool) {
  await pool.query('CREATE SCHEMA IF NOT EXISTS drizzle');
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
}

async function seedSystemSettings(db: ReturnType<typeof drizzle>) {
  await db
    .insert(systemSettings)
    .values({
      id: SYSTEM_SETTINGS_ID,
      commissionPercent: 7,
      insurancePercent: 5,
      instantCashoutEnabled: false,
      maxInstantCashoutCents: 50000,
      dispatchRadiusKm: 25,
      refundLimitAdmin: 500,
      refundLimitModerator: 0,
      disputeAutoCloseDays: 14,
      maintenanceMode: false,
    })
    .onConflictDoNothing({ target: systemSettings.id });
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = getProjectRoot();
  const databaseUrl = requireDatabaseUrl();

  if (!flags.noCreate) {
    await ensureDatabaseExists(databaseUrl, flags.reset);
  }

  const pool = new Pool({ ...getPgConnectionConfig(databaseUrl), connectionTimeoutMillis: 10000 });

  try {
    await ensurePostgresPrereqs(pool);

    const db = drizzle(pool);

    if (!flags.seedOnly) {
      console.log('Running Drizzle migrations...');
      await migrate(db, { migrationsFolder: path.join(projectRoot, 'drizzle') });
      console.log('Migrations complete.');
    }

    if (!flags.migrateOnly) {
      console.log('Seeding baseline data...');
      await seedSystemSettings(db);
      await seedPricingCatalog(pool);
      console.log('Baseline seed complete.');
    }

    const tables = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const settings = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM system_settings',
    );

    console.log(
      `Database ${getDatabaseName(databaseUrl)} ready: ${tables.rows[0]?.count ?? '0'} public tables, ${settings.rows[0]?.count ?? '0'} system_settings row(s).`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Database setup failed:', error);
  process.exit(1);
});
