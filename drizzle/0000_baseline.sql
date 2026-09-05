CREATE TYPE "public"."admin_role" AS ENUM('super_admin', 'admin', 'moderator');--> statement-breakpoint
CREATE TYPE "public"."admin_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."app_type" AS ENUM('STORE', 'CUSTOMER');--> statement-breakpoint
CREATE TYPE "public"."audit_action_type" AS ENUM('auth', 'order', 'store', 'user', 'finance', 'settings', 'admin', 'dispute', 'review', 'onboarding');--> statement-breakpoint
CREATE TYPE "public"."billing_type" AS ENUM('ONE_TIME', 'MONTHLY');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('OPEN', 'UNDER_REVIEW', 'APPROVED', 'DENIED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."claim_urgency" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."dispatch_status" AS ENUM('PENDING', 'SENT', 'SEEN', 'OFFERED', 'ACCEPTED', 'DECLINED', 'SKIPPED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."dispute_reason_code" AS ENUM('DEVICE_NOT_FIXED', 'NEW_DAMAGE', 'WRONG_REPAIR', 'MISSING_PARTS', 'OVERCHARGED', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."dispute_sender_role" AS ENUM('CUSTOMER', 'SHOP', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('OPEN', 'IN_PROGRESS', 'UNDER_REVIEW', 'FINALIZING', 'RESOLVED_REFUND', 'RESOLVED_RELEASED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."inventory_movement_type" AS ENUM('RESERVED', 'RELEASED', 'USED', 'ADJUSTMENT', 'RESTOCK', 'STOCK_IN', 'STOCK_OUT');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('BOOKED', 'CHECKED_IN', 'IN_PROGRESS', 'READY', 'COMPLETED', 'DISPUTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."media_type" AS ENUM('IMAGE', 'VIDEO');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('TEXT', 'IMAGE', 'VIDEO');--> statement-breakpoint
CREATE TYPE "public"."notification_category" AS ENUM('order', 'dispatch', 'chat', 'dispute', 'payout', 'review', 'system', 'offer', 'protection');--> statement-breakpoint
CREATE TYPE "public"."notification_target" AS ENUM('STORE', 'CUSTOMER', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."onboarding_status" AS ENUM('NOT_STARTED', 'IN_REVIEW', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."parts_quality" AS ENUM('AFTERMARKET', 'PREMIUM', 'ORIGINAL');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('HELD', 'CAPTURED', 'RELEASED', 'REFUNDED', 'PAYMENT_FAILED');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('ACTIVE', 'PAUSED');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('LIVE', 'DISPATCHING', 'OFFERED', 'ACCEPTED', 'BOOKED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."review_media_type" AS ENUM('IMAGE', 'VIDEO');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('OWNER', 'MANAGER', 'TECH');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('ACTIVE', 'PAST_DUE', 'CANCELED');--> statement-breakpoint
CREATE TYPE "public"."support_conversation_status" AS ENUM('waiting', 'active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."support_message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_status" AS ENUM('open', 'in_review', 'closed');--> statement-breakpoint
CREATE TYPE "public"."user_type" AS ENUM('CUSTOMER', 'SHOP_OWNER', 'ADMIN');--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"role" "admin_role" DEFAULT 'admin' NOT NULL,
	"status" "admin_status" DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"performed_by" varchar(255) NOT NULL,
	"performed_by_role" varchar(50) NOT NULL,
	"action" text NOT NULL,
	"action_type" "audit_action_type" NOT NULL,
	"target" varchar(500),
	"details" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" varchar(50) NOT NULL,
	"address" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"city" varchar(100),
	"state" varchar(100),
	"zip_code" varchar(20),
	"country" varchar(100),
	"place_id" varchar(100),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_notification_prefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"offers" boolean DEFAULT true NOT NULL,
	"messages" boolean DEFAULT true NOT NULL,
	"order_updates" boolean DEFAULT true NOT NULL,
	"payments" boolean DEFAULT true NOT NULL,
	"reviews" boolean DEFAULT false NOT NULL,
	"promotions" boolean DEFAULT false NOT NULL,
	CONSTRAINT "customer_notification_prefs_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "device_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand" varchar(100) NOT NULL,
	"device_type" varchar(50) DEFAULT 'Smartphone' NOT NULL,
	"model_name" varchar(255) NOT NULL,
	"model_number" varchar(150),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_models_brand_model_name_key" UNIQUE("brand","model_name")
);
--> statement-breakpoint
CREATE TABLE "dispatch_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"distance_km" integer,
	"status" "dispatch_status" DEFAULT 'PENDING' NOT NULL,
	"seen_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"score" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispute_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"sender_role" "dispute_sender_role" NOT NULL,
	"message" text NOT NULL,
	"evidence_urls" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"reason_code" "dispute_reason_code" NOT NULL,
	"description" text NOT NULL,
	"evidence_urls" jsonb DEFAULT '[]'::jsonb,
	"dispute_video_url" text,
	"dispute_video_duration_ms" text,
	"status" "dispute_status" DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"device_model_id" uuid,
	"device_model" varchar(255) NOT NULL,
	"device_brand" varchar(100) NOT NULL,
	"model_number" varchar(150),
	"part_type" varchar(200) NOT NULL,
	"quality" varchar(50) NOT NULL,
	"condition" varchar(50) DEFAULT 'new' NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"quantity_reserved" integer DEFAULT 0 NOT NULL,
	"cost_price_cents" integer DEFAULT 0 NOT NULL,
	"sell_price_cents" integer DEFAULT 0 NOT NULL,
	"low_stock_threshold" integer DEFAULT 5 NOT NULL,
	"supplier" varchar(255),
	"warranty_days" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_items_shop_model_part_quality_condition_uniq" UNIQUE("shop_id","device_model","part_type","quality","condition")
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"type" "inventory_movement_type" NOT NULL,
	"quantity" integer NOT NULL,
	"note" text,
	"reference_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"type" "media_type" NOT NULL,
	"url" text NOT NULL,
	"public_id" varchar(500) NOT NULL,
	"thumb_url" text,
	"duration_ms" integer,
	"size_bytes" integer,
	"mime_type" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"from_status" varchar(30),
	"to_status" varchar(30) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_name" varchar(255) NOT NULL,
	"device_brand" varchar(100) NOT NULL,
	"device_model" varchar(255) NOT NULL,
	"issue_description" text NOT NULL,
	"price_cents" integer NOT NULL,
	"eta_minutes" integer NOT NULL,
	"warranty_days" integer DEFAULT 0 NOT NULL,
	"parts_quality" varchar(20) DEFAULT 'AFTERMARKET' NOT NULL,
	"status" "job_status" DEFAULT 'BOOKED' NOT NULL,
	"payment_status" "payment_status" DEFAULT 'HELD' NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"stripe_payment_intent_id" varchar(255),
	"platform_fee_cents" integer DEFAULT 0 NOT NULL,
	"proof_media" jsonb DEFAULT '[]'::jsonb,
	"customer_initial_video_url" text,
	"shop_completion_video_url" text,
	"dispute_reason" text,
	"payment_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"client_message_id" varchar(100) NOT NULL,
	"sender_id" uuid NOT NULL,
	"sender_role" varchar(20) NOT NULL,
	"type" "message_type" DEFAULT 'TEXT' NOT NULL,
	"text" text,
	"media_url" text,
	"public_id" varchar(500),
	"thumb_url" text,
	"duration_ms" integer,
	"seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_type" "notification_target" NOT NULL,
	"category" "notification_category" NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"price_cents" integer NOT NULL,
	"eta_minutes" integer NOT NULL,
	"warranty_days" integer DEFAULT 0 NOT NULL,
	"parts_quality" "parts_quality" DEFAULT 'AFTERMARKET' NOT NULL,
	"note" text,
	"status" "offer_status" DEFAULT 'PENDING' NOT NULL,
	"reserve_inventory_item_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"owner_first_name" varchar(100) NOT NULL,
	"owner_last_name" varchar(100) NOT NULL,
	"owner_dob" varchar(20) NOT NULL,
	"llc_document_urls" jsonb DEFAULT '[]'::jsonb,
	"incorporation_doc_url" varchar(1000),
	"business_license_url" varchar(1000),
	"id_document_url" varchar(1000) NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_submissions_shop_id_unique" UNIQUE("shop_id")
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"job_id" uuid,
	"amount_cents" integer NOT NULL,
	"platform_fee_cents" integer DEFAULT 0 NOT NULL,
	"net_amount_cents" integer DEFAULT 0 NOT NULL,
	"payout_method" varchar(32),
	"stripe_payout_id" varchar(255),
	"stripe_transfer_id" varchar(255),
	"status" "payout_status" DEFAULT 'PENDING' NOT NULL,
	"arrival_date" timestamp with time zone,
	"failure_message" varchar(1000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "protection_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_name" varchar(255) NOT NULL,
	"job_id" uuid,
	"device_model" varchar(255) NOT NULL,
	"reason" text NOT NULL,
	"evidence_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "claim_status" DEFAULT 'OPEN' NOT NULL,
	"urgency" "claim_urgency" DEFAULT 'LOW' NOT NULL,
	"decision_notes" text,
	"payout_amount_cents" integer DEFAULT 0 NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protection_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"billing_type" "billing_type" NOT NULL,
	"price_cents" integer NOT NULL,
	"coverage_days" integer DEFAULT 0 NOT NULL,
	"covered_part_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_claims_per_period" integer DEFAULT 1 NOT NULL,
	"max_payout_per_claim_cents" integer NOT NULL,
	"deductible_cents" integer DEFAULT 0 NOT NULL,
	"terms_text" text,
	"exclusions_text" text,
	"status" "plan_status" DEFAULT 'ACTIVE' NOT NULL,
	"stripe_product_id" varchar(255),
	"stripe_price_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protection_subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_name" varchar(255) NOT NULL,
	"status" "subscription_status" DEFAULT 'ACTIVE' NOT NULL,
	"stripe_subscription_id" varchar(255),
	"autopay_enabled" boolean DEFAULT true NOT NULL,
	"total_paid_cents" integer DEFAULT 0 NOT NULL,
	"claims_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_bill_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"platform" varchar(10) NOT NULL,
	"app_type" "app_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_name" varchar(255) NOT NULL,
	"device_brand" varchar(100) NOT NULL,
	"device_model" varchar(255) NOT NULL,
	"issue_type" varchar(50),
	"issue_description" text NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb,
	"video_url" text,
	"customer_offer_cents" integer NOT NULL,
	"min_price_cents" integer NOT NULL,
	"latitude" varchar(20),
	"longitude" varchar(20),
	"address" text,
	"status" "request_status" DEFAULT 'LIVE' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"type" "review_media_type" NOT NULL,
	"url" varchar(1000) NOT NULL,
	"public_id" varchar(500),
	"thumb_url" varchar(1000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"replier_user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_replies_review_id_key" UNIQUE("review_id")
);
--> statement-breakpoint
CREATE TABLE "review_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"reason" varchar(100) NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_name" varchar(255) NOT NULL,
	"job_id" uuid,
	"rating" integer NOT NULL,
	"text" text,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"is_reported" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_job_customer_key" UNIQUE("job_id","customer_id")
);
--> statement-breakpoint
CREATE TABLE "shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"onboarding_status" "onboarding_status" DEFAULT 'NOT_STARTED' NOT NULL,
	"rejection_reason" text,
	"stripe_account_id" varchar(255),
	"stripe_connected" boolean DEFAULT false NOT NULL,
	"stripe_charges_enabled" boolean DEFAULT false NOT NULL,
	"stripe_payouts_enabled" boolean DEFAULT false NOT NULL,
	"manual_payout_freeze" boolean DEFAULT false NOT NULL,
	"manual_payout_freeze_reason" text,
	"manual_payout_frozen_at" timestamp with time zone,
	"manual_payout_frozen_by_admin_id" uuid,
	"stripe_payout_freeze_code" varchar(255),
	"stripe_payout_freeze_reason" text,
	"stripe_payout_status_synced_at" timestamp with time zone,
	"vacation_mode" boolean DEFAULT false NOT NULL,
	"phone" varchar(30),
	"website" varchar(500),
	"description" text,
	"categories" jsonb DEFAULT '[]'::jsonb,
	"logo_url" varchar(1000),
	"address" text,
	"city" varchar(100),
	"state" varchar(100),
	"zip_code" varchar(20),
	"country" varchar(100),
	"place_id" varchar(300),
	"latitude" varchar(20),
	"longitude" varchar(20),
	"service_radius" integer,
	"business_hours" jsonb,
	"warranty_enabled" boolean DEFAULT false NOT NULL,
	"default_warranty_days" integer DEFAULT 90 NOT NULL,
	"per_part_warranty_overrides" jsonb DEFAULT '[]'::jsonb,
	"warranty_policy_text" text,
	"priority_enabled" boolean DEFAULT false NOT NULL,
	"priority_level" integer,
	"protection_enabled" boolean DEFAULT false NOT NULL,
	"notification_sound" boolean DEFAULT true NOT NULL,
	"notification_vibration" boolean DEFAULT true NOT NULL,
	"quiet_hours_start" varchar(5),
	"quiet_hours_end" varchar(5),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_agent_status" (
	"admin_user_id" uuid PRIMARY KEY NOT NULL,
	"is_available" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(255),
	"category" varchar(100),
	"description" text,
	"status" "support_conversation_status" DEFAULT 'waiting' NOT NULL,
	"ticket_status" "support_ticket_status" DEFAULT 'open' NOT NULL,
	"agent_id" uuid,
	"agent_name" varchar(255),
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "support_message_role" NOT NULL,
	"content" text NOT NULL,
	"type" varchar(20) DEFAULT 'text' NOT NULL,
	"media_url" text,
	"sender_name" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commission_percent" integer DEFAULT 15 NOT NULL,
	"insurance_percent" integer DEFAULT 5 NOT NULL,
	"instant_cashout_enabled" boolean DEFAULT false NOT NULL,
	"max_instant_cashout_cents" integer DEFAULT 50000 NOT NULL,
	"dispatch_radius_km" integer DEFAULT 25 NOT NULL,
	"refund_limit_admin" integer DEFAULT 500 NOT NULL,
	"refund_limit_moderator" integer DEFAULT 0 NOT NULL,
	"dispute_auto_close_days" integer DEFAULT 14 NOT NULL,
	"maintenance_mode" boolean DEFAULT false NOT NULL,
	"cloudinary_cloud_name" varchar(255),
	"cloudinary_api_key" varchar(255),
	"cloudinary_api_secret" varchar(255),
	"stripe_secret_key" varchar(512),
	"stripe_publishable_key" varchar(512),
	"stripe_webhook_secret" varchar(512),
	"smtp_host" varchar(255),
	"smtp_port" integer,
	"smtp_user" varchar(255),
	"smtp_pass" varchar(512),
	"smtp_from" varchar(255),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"full_name" varchar(255),
	"phone" varchar(20),
	"avatar_url" text,
	"user_type" "user_type" DEFAULT 'SHOP_OWNER' NOT NULL,
	"stripe_customer_id" text,
	"status" varchar(20) DEFAULT 'ACTIVE' NOT NULL,
	"privacy_share_usage" boolean DEFAULT true NOT NULL,
	"privacy_share_location" boolean DEFAULT true NOT NULL,
	"privacy_share_repair_history" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_email_user_type_unique" UNIQUE("email","user_type")
);
--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notification_prefs" ADD CONSTRAINT "customer_notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_targets" ADD CONSTRAINT "dispatch_targets_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_targets" ADD CONSTRAINT "dispatch_targets_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_messages" ADD CONSTRAINT "dispute_messages_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_device_model_id_device_models_id_fk" FOREIGN KEY ("device_model_id") REFERENCES "public"."device_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_media" ADD CONSTRAINT "job_media_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_status_events" ADD CONSTRAINT "job_status_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_submissions" ADD CONSTRAINT "onboarding_submissions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protection_claims" ADD CONSTRAINT "protection_claims_plan_id_protection_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."protection_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protection_claims" ADD CONSTRAINT "protection_claims_subscription_id_protection_subscribers_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."protection_subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protection_claims" ADD CONSTRAINT "protection_claims_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protection_claims" ADD CONSTRAINT "protection_claims_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protection_plans" ADD CONSTRAINT "protection_plans_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protection_subscribers" ADD CONSTRAINT "protection_subscribers_plan_id_protection_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."protection_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protection_subscribers" ADD CONSTRAINT "protection_subscribers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_media" ADD CONSTRAINT "review_media_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_agent_status" ADD CONSTRAINT "support_agent_status_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_conversations" ADD CONSTRAINT "support_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_conversations" ADD CONSTRAINT "support_conversations_agent_id_admin_users_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_conversation_id_support_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."support_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_device_models_brand" ON "device_models" USING btree ("brand");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_request_shop_idx" ON "dispatch_targets" USING btree ("request_id","shop_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_items_shop_id" ON "inventory_items" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_movements_item_id" ON "inventory_movements" USING btree ("inventory_item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_shop_idx" ON "memberships" USING btree ("user_id","shop_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_message_id_idx" ON "messages" USING btree ("job_id","client_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_request_shop_idx" ON "offers" USING btree ("request_id","shop_id");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_token_hash_idx" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_token_hash_idx" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_reviews_shop_created" ON "reviews" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_reviews_shop_rating" ON "reviews" USING btree ("shop_id","rating");