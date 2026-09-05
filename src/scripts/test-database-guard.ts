import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';

function identity(value: string) {
  const url = new URL(value);
  return `${url.hostname}:${url.port || '5432'}${decodeURIComponent(url.pathname)}`;
}

/** This implementation is authorized for test databases only. */
export function assertTestDatabase(databaseUrl: string) {
  const url = new URL(databaseUrl);
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && /test/i.test(url.pathname)) return;
  // Remote work is allowed only from the named test checkout, against its exact
  // configured database, and with an independent check against the main checkout.
  const root = new URL('../../', import.meta.url);
  if (!decodeURIComponent(root.pathname).endsWith('/Repairebel-Server -test/')) throw new Error('Remote pricing imports are restricted to the test checkout');
  const test = parse(readFileSync(new URL('.env', root))).DATABASE_URL;
  const main = parse(readFileSync(new URL('../Repairebel-Server/.env', root))).DATABASE_URL;
  if (!test || !main || identity(databaseUrl) !== identity(test) || identity(databaseUrl) === identity(main)) {
    throw new Error('Refusing database changes: target is not independently verified as the test database');
  }
}
