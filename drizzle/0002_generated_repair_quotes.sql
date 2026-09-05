CREATE TABLE IF NOT EXISTS generated_repair_quotes (
  cache_key varchar(64) PRIMARY KEY,
  snapshot jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_generated_repair_quotes_expiry ON generated_repair_quotes (expires_at);
