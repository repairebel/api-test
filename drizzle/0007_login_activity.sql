CREATE TABLE IF NOT EXISTS "login_activity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "user_type" varchar(20) NOT NULL,
  "ip_address" varchar(64),
  "location" varchar(255),
  "device_name" varchar(255),
  "platform" varchar(64),
  "user_agent" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "login_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);
CREATE INDEX IF NOT EXISTS "login_activity_user_created_idx" ON "login_activity" USING btree ("user_id","created_at");
CREATE INDEX IF NOT EXISTS "login_activity_created_idx" ON "login_activity" USING btree ("created_at");
