CREATE TABLE "rate_limits" (
	"bucket_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "scope" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limits_bucket_window_idx" ON "rate_limits" USING btree ("bucket_key","window_start");--> statement-breakpoint
CREATE INDEX "rate_limits_window_idx" ON "rate_limits" USING btree ("window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "worlds_one_active_demo_idx" ON "worlds" USING btree ("kind") WHERE "worlds"."kind" = 'demo' AND "worlds"."status" = 'active';--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_scope_check" CHECK ("api_keys"."scope" IN ('full', 'read_only'));--> statement-breakpoint
ALTER TABLE "worlds" ADD CONSTRAINT "worlds_demo_is_sim" CHECK ("worlds"."kind" <> 'demo' OR "worlds"."rail_mode" = 'sim');