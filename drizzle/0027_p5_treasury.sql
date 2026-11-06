CREATE TABLE "treasury_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"reserve_floor_bps" integer DEFAULT 1500 NOT NULL,
	"concentration_bps" integer DEFAULT 3000 NOT NULL,
	"daily_budget_bps" integer DEFAULT 4000 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_policy_world_id_unique" UNIQUE("world_id")
);
--> statement-breakpoint
ALTER TABLE "economy_state" ADD COLUMN "day_start_liquidity_cents" bigint;--> statement-breakpoint
ALTER TABLE "economy_state" ADD COLUMN "treasury_memo" jsonb;--> statement-breakpoint
ALTER TABLE "economy_state" ADD COLUMN "treasury_memo_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "economy_state" ADD COLUMN "treasury_memo_ai_run_id" uuid;--> statement-breakpoint
ALTER TABLE "note_transactions" ADD COLUMN "queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "treasury_policy" ADD CONSTRAINT "treasury_policy_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_state" ADD CONSTRAINT "economy_state_treasury_memo_ai_run_id_ai_runs_id_fk" FOREIGN KEY ("treasury_memo_ai_run_id") REFERENCES "public"."ai_runs"("id") ON DELETE no action ON UPDATE no action;