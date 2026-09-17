ALTER TABLE "shops" ADD COLUMN "is_suspended" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
WITH "latest_admin_shop_action" AS (
	SELECT DISTINCT ON ("target") "target", "action"
	FROM "audit_logs"
	WHERE "action_type" = 'store'
		AND "target" IS NOT NULL
		AND ("action" LIKE 'Suspended shop %' OR "action" LIKE 'Activated shop %')
	ORDER BY "target", "created_at" DESC
)
UPDATE "shops" AS "shop"
SET "is_suspended" = true,
	"vacation_mode" = false,
	"updated_at" = now()
FROM "latest_admin_shop_action" AS "latest"
WHERE "latest"."target" = "shop"."id"::text
	AND "latest"."action" LIKE 'Suspended shop %';
