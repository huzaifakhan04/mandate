ALTER TABLE "worlds" ADD COLUMN "bot_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Ruling P5-A (data): the main world's treasury policy. Judges share a small sandbox pool, so the
-- daily budget is the whole day-start liquidity and one principal may hold half of the book; the
-- reserve floor stays 15%. New main worlds get the same row from ensureMainWorld.
INSERT INTO "treasury_policy" ("world_id", "reserve_floor_bps", "concentration_bps", "daily_budget_bps")
SELECT "id", 1500, 5000, 10000 FROM "worlds" WHERE "slug" = 'main'
ON CONFLICT ("world_id") DO NOTHING;
