CREATE TABLE "repair_price_sources" (
	"catalog_version" varchar(100) NOT NULL,
	"source_id" integer NOT NULL,
	"source" jsonb NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_price_sources_catalog_version_source_id_pk" PRIMARY KEY("catalog_version","source_id")
);
--> statement-breakpoint
CREATE TABLE "repair_prices" (
	"device_model_id" uuid NOT NULL,
	"issue_type" varchar(50) NOT NULL,
	"category" varchar(100) NOT NULL,
	"parts_cost" numeric(14, 4) NOT NULL,
	"markup_multiplier" numeric(8, 4) NOT NULL,
	"labor_fee_cents" integer NOT NULL,
	"suggested_price_cents" integer NOT NULL,
	"catalog_version" varchar(100) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"snapshot" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_prices_device_model_id_issue_type_pk" PRIMARY KEY("device_model_id","issue_type")
);
--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "device_model_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "price_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "repair_prices" ADD CONSTRAINT "repair_prices_device_model_id_device_models_id_fk" FOREIGN KEY ("device_model_id") REFERENCES "public"."device_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_repair_prices_active_model" ON "repair_prices" USING btree ("active","device_model_id");