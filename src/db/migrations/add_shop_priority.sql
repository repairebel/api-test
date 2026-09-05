-- Migration: add priority columns to shops table
-- Run this against your repairrebel database

ALTER TABLE shops ADD COLUMN IF NOT EXISTS priority_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS priority_level INTEGER;
