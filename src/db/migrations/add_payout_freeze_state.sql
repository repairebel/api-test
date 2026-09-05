ALTER TABLE "shops"
  ADD COLUMN "manual_payout_freeze" boolean NOT NULL DEFAULT false,
  ADD COLUMN "manual_payout_freeze_reason" text,
  ADD COLUMN "manual_payout_frozen_at" timestamp with time zone,
  ADD COLUMN "manual_payout_frozen_by_admin_id" uuid,
  ADD COLUMN "stripe_payout_freeze_code" varchar(255),
  ADD COLUMN "stripe_payout_freeze_reason" text,
  ADD COLUMN "stripe_payout_status_synced_at" timestamp with time zone;
