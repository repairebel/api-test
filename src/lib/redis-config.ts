import type { RedisOptions } from 'ioredis';
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';

function parseRedisDb(pathname: string) {
  const value = pathname.replace(/^\/+/, '');
  if (!value) return 0;

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function getRedisConnectionOptions(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl);
  const options: RedisOptions = {
    host: url.hostname,
    port: Number.parseInt(url.port || '6379', 10),
    db: parseRedisDb(url.pathname || '/0'),
  };

  if (url.username) {
    options.username = decodeURIComponent(url.username);
  }

  if (url.password) {
    options.password = decodeURIComponent(url.password);
  }

  if (url.protocol === 'rediss:') {
    const insecure = (url.searchParams.get('insecure') || '').toLowerCase() === 'true';
    options.tls = {
      rejectUnauthorized: !insecure,
    } satisfies TlsConnectionOptions;
  }

  return options;
}
