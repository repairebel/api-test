import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, symlink, access, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import {buildCatalog, readCatalog} from '../dist/modules/pricing/catalog.js';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const built = buildCatalog(readCatalog());
const expected = {models: built.modelCount, prices: built.prices.length, sources: built.sourceCount};

test('Railway compiled setup seeds a fresh DB and repeats without local source files or SQL dumps', { timeout: 120000 }, async () => {
  const url = new URL(process.env.TEST_DATABASE_URL || `postgresql://${encodeURIComponent(userInfo().username)}@localhost:5432/postgres`);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Deployment tests require a local PostgreSQL server');
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  const name = `repairebel_deploy_test_${randomUUID().replaceAll('-', '')}`;
  const stage = await mkdtemp(join(tmpdir(), 'repairebel-deploy-'));
  let database;
  let created = false;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    url.pathname = `/${name}`;
    database = new pg.Client({ connectionString: url.toString() });
    await database.connect();
    await cp(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
    await cp(join(root, 'drizzle'), join(stage, 'drizzle'), { recursive: true });
    await cp(join(root, 'package.json'), join(stage, 'package.json'));
    await symlink(join(root, 'node_modules'), join(stage, 'node_modules'), 'dir');
    for (const missing of ['database-seed.sql', '.env', 'src']) {
      await assert.rejects(access(join(stage, missing)));
    }
    const env = { PATH: process.env.PATH, NODE_ENV: 'production', DATABASE_URL: url.toString() };
    const setup = () => execute(process.execPath, ['dist/scripts/setup-db.js', '--no-create'], { cwd: stage, env, timeout: 45000 });
    const first = await setup();
    assert.match(first.stdout, /Migrations complete/);
    assert.ok(first.stdout.includes(`Imported ${expected.sources} source rows and ${expected.prices} suggested prices`));
    const counts = () => database.query(`SELECT
      (SELECT count(*)::int FROM device_models) AS models,
      (SELECT count(*)::int FROM repair_prices WHERE active) AS prices,
      (SELECT count(*)::int FROM repair_price_sources) AS sources`);
    assert.deepEqual((await counts()).rows[0], expected);
    assert.equal((await database.query('SELECT count(*)::int AS count FROM device_models WHERE model_number IS NULL')).rows[0].count, 0);
    assert.equal((await database.query('SELECT count(*)::int AS count FROM repair_prices WHERE markup_multiplier <> 2 OR labor_fee_cents <> 3000 OR suggested_price_cents <> ceil((parts_cost*2+30)*100)')).rows[0].count, 0);
    const beforeIds = (await database.query('SELECT id FROM device_models ORDER BY id')).rows;
    // Existing operator settings must survive deployment seeds.
    await database.query('UPDATE system_settings SET commission_percent=9');
    const second = await setup();
    assert.match(second.stdout, /Database .* ready/);
    assert.deepEqual((await counts()).rows[0], expected);
    assert.deepEqual((await database.query('SELECT id FROM device_models ORDER BY id')).rows, beforeIds);
    assert.equal((await database.query('SELECT commission_percent FROM system_settings')).rows[0].commission_percent, 9);
  } finally {
    if (database) await database.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
    await rm(stage, { recursive: true, force: true });
  }
});
