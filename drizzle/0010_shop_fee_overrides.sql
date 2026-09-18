ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "custom_commission_percent" integer;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "custom_insurance_percent" integer;
--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_custom_commission_percent_range" CHECK ("custom_commission_percent" IS NULL OR ("custom_commission_percent" >= 0 AND "custom_commission_percent" <= 100));
--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_custom_insurance_percent_range" CHECK ("custom_insurance_percent" IS NULL OR ("custom_insurance_percent" >= 0 AND "custom_insurance_percent" <= 100));
