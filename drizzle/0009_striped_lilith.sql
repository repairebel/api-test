CREATE TYPE "public"."order_adjustment_status" AS ENUM('REQUESTED', 'AUTHORIZED', 'DECLINED', 'CANCELLED', 'CAPTURED', 'REFUNDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."order_tip_status" AS ENUM('PENDING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TABLE "order_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"previous_price_cents" integer NOT NULL,
	"adjustment_cents" integer NOT NULL,
	"new_total_cents" integer NOT NULL,
	"status" "order_adjustment_status" DEFAULT 'REQUESTED' NOT NULL,
	"stripe_payment_intent_id" varchar(255),
	"stripe_transfer_id" varchar(255),
	"payment_error" varchar(1000),
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_tips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"platform_fee_cents" integer DEFAULT 0 NOT NULL,
	"status" "order_tip_status" DEFAULT 'PENDING' NOT NULL,
	"stripe_payment_intent_id" varchar(255),
	"stripe_transfer_id" varchar(255),
	"payment_error" varchar(1000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_tips_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
ALTER TABLE "order_adjustments" ADD CONSTRAINT "order_adjustments_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_adjustments" ADD CONSTRAINT "order_adjustments_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_tips" ADD CONSTRAINT "order_tips_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_tips" ADD CONSTRAINT "order_tips_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;