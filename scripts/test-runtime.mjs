import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

// An explicit local runtime prevents the checked-in project's .env integrations
// from reaching the production Redis queues, mail service, or payment account.
const root = fileURLToPath(new URL('../', import.meta.url));
const databaseUrl = process.env.TEST_DATABASE_URL || `postgresql://${encodeURIComponent(userInfo().username)}@localhost:5432/repairebel_pricing_test`;
const redisUrl = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6385/0';
for (const value of [databaseUrl, redisUrl]) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname)) throw new Error('The test runtime requires local PostgreSQL and Redis.');
}
if (!/test/i.test(new URL(databaseUrl).pathname)) throw new Error('The test database name must contain test.');
const mode = process.argv[2] || 'dev';
const args = mode === 'setup' ? ['src/scripts/setup-db.ts']
  : mode === 'import' ? ['src/scripts/import-repair-prices.ts', '--apply']
  : mode === 'test' ? ['--test', 'test/pricing.test.ts', 'test/pricing-api.test.ts']
  : mode === 'dev' ? ['watch', 'src/index.ts'] : null;
if (!args) throw new Error('Use dev, setup, import, or test');
const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', ...args, ...process.argv.slice(3)], {
  cwd: root, stdio: 'inherit', env: {
    ...process.env, NODE_ENV: 'test', PORT: '6065', DATABASE_URL: databaseUrl, REDIS_URL: redisUrl,
    JWT_ACCESS_SECRET: 'local-test-access-secret-0000000000000000',
    JWT_REFRESH_SECRET: 'local-test-refresh-secret-000000000000000',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: 'Test <test@example.invalid>',
    STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', STRIPE_PUBLISHABLE_KEY: '', OPENAI_API_KEY: '',
    CLOUDINARY_CLOUD_NAME: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '',
  },
});
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
