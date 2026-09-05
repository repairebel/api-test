import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';
import { getPgConnectionConfig } from '../lib/postgres-config.js';

const pool = new pg.Pool({
  ...getPgConnectionConfig(env.DATABASE_URL),
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

export const db = drizzle(pool, { schema });
export { pool };
