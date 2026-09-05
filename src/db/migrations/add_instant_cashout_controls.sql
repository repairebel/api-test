ALTER TABLE "system_settings"
  ADD COLUMN "instant_cashout_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN "max_instant_cashout_cents" integer NOT NULL DEFAULT 50000;

ALTER TABLE "payouts"
  ADD COLUMN "payout_method" varchar(32),
  ADD COLUMN "arrival_date" timestamp with time zone,
  ADD COLUMN "failure_message" varchar(1000);
