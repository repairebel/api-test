import pg from 'pg';

function getSslMode(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return (url.searchParams.get('sslmode') || '').toLowerCase();
}

export function getPgConnectionConfig(databaseUrl: string): pg.PoolConfig {
  const sslMode = getSslMode(databaseUrl);
  const config: pg.PoolConfig = {
    connectionString: databaseUrl,
  };

  if (sslMode === 'no-verify') {
    config.ssl = { rejectUnauthorized: false };
  } else if (sslMode && sslMode !== 'disable') {
    config.ssl = { rejectUnauthorized: true };
  }

  return config;
}
