CREATE TABLE "app_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app" varchar(20) NOT NULL,
	"platform" varchar(10) NOT NULL,
	"latest_version" varchar(20) NOT NULL,
	"min_required_version" varchar(20) NOT NULL,
	"store_url" varchar(512) NOT NULL,
	"update_message" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "app_releases_app_platform_idx" ON "app_releases" USING btree ("app","platform");