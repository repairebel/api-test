-- Migration: add notifications table
-- Run this against your repairrebel database

DO $$ BEGIN
  CREATE TYPE "notification_target" AS ENUM ('STORE', 'CUSTOMER', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "notification_category" AS ENUM ('order', 'dispatch', 'chat', 'dispute', 'payout', 'review', 'system', 'offer', 'protection');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "target_type" "notification_target" NOT NULL,
  "category" "notification_category" NOT NULL,
  "title" varchar(255) NOT NULL,
  "body" text NOT NULL,
  "data" jsonb DEFAULT '{}',
  "read" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS "idx_notifications_user_id" ON "notifications"("user_id");
CREATE INDEX IF NOT EXISTS "idx_notifications_user_read" ON "notifications"("user_id", "read");
CREATE INDEX IF NOT EXISTS "idx_notifications_created_at" ON "notifications"("created_at" DESC);
