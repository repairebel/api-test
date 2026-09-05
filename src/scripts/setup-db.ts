import 'dotenv/config';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';

import { deviceModels } from '../db/schema/inventory.js';
import { systemSettings } from '../db/schema/system-settings.js';
import { getPgConnectionConfig } from '../lib/postgres-config.js';

const { Client, Pool } = pg;

const SYSTEM_SETTINGS_ID = '00000000-0000-0000-0000-000000000001';
const DEVICE_MODEL_INSERT_PREFIX = 'INSERT INTO public.device_models VALUES (';

type Flags = {
  migrateOnly: boolean;
  seedOnly: boolean;
  reset: boolean;
  noCreate: boolean;
};

type DeviceModelSeed = {
  brand: string;
  deviceType: string;
  modelName: string;
  modelNumber: string | null;
  createdAt: Date;
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

function parseSqlTuple(tuple: string): Array<string | null> {
  const values: Array<string | null> = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < tuple.length; i += 1) {
    const char = tuple[i]!;

    if (inString) {
      if (char === "'") {
        if (tuple[i + 1] === "'") {
          current += "'";
          i += 1;
        } else {
          inString = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'") {
      inString = true;
      continue;
    }

    if (char === ',') {
      const raw = current.trim();
      values.push(raw === 'NULL' ? null : raw);
      current = '';
      continue;
    }

    current += char;
  }

  const raw = current.trim();
  values.push(raw === 'NULL' ? null : raw);
  return values;
}

async function loadDeviceModelsFromDump(seedFilePath: string): Promise<DeviceModelSeed[]> {
  const contents = await fs.readFile(seedFilePath, 'utf8');
  const seeds: DeviceModelSeed[] = [];

  for (const line of contents.split('\n')) {
    if (!line.startsWith(DEVICE_MODEL_INSERT_PREFIX)) continue;

    const tuple = line.slice(
      DEVICE_MODEL_INSERT_PREFIX.length,
      line.length - 2,
    );
    const values = parseSqlTuple(tuple);

    if (values.length !== 6) {
      throw new Error(`Unexpected device_models seed row format: ${line}`);
    }

    const [, brand, modelName, modelNumber, createdAt, deviceType] = values;

    if (!brand || !modelName || !createdAt || !deviceType) {
      throw new Error(`Incomplete device_models seed row: ${line}`);
    }

    seeds.push({
      brand,
      modelName,
      modelNumber,
      deviceType,
      createdAt: new Date(createdAt),
    });
  }

  if (seeds.length === 0) {
    throw new Error(`No device_models rows found in ${seedFilePath}`);
  }

  return seeds;
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
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

async function seedDeviceModels(db: ReturnType<typeof drizzle>, projectRoot: string) {
  const seedFilePath = path.join(projectRoot, 'database-seed.sql');
  const seeds = await loadDeviceModelsFromDump(seedFilePath);

  for (const batch of chunk(seeds, 250)) {
    await db
      .insert(deviceModels)
      .values(batch)
      .onConflictDoUpdate({
        target: [deviceModels.brand, deviceModels.modelName],
        set: {
          deviceType: sql.raw('excluded.device_type'),
          modelNumber: sql.raw('excluded.model_number'),
        },
      });
  }

  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(deviceModels);

  console.log(`Seeded device_models catalog (${result[0]?.count ?? 0} rows).`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = getProjectRoot();
  const databaseUrl = requireDatabaseUrl();

  if (!flags.noCreate) {
    await ensureDatabaseExists(databaseUrl, flags.reset);
  }

  const pool = new Pool(getPgConnectionConfig(databaseUrl));

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
      await seedDeviceModels(db, projectRoot);
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
