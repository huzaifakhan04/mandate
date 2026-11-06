CREATE TABLE "agent_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"principal_id" uuid,
	"kind" text NOT NULL,
	"loan_id" uuid,
	"sim_at" timestamp with time zone NOT NULL,
	"body" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_ladder_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"step" text NOT NULL,
	"due_sim_at" timestamp with time zone NOT NULL,
	"applied_sim_at" timestamp with time zone NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "loans_one_open_per_agent_idx";--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "late_fee_outstanding_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "penalty_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "penalty_outstanding_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "penalty_accrued_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "delinquency_step" text;--> statement-breakpoint
ALTER TABLE "repayments" ADD COLUMN "applied_penalty_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_notices" ADD CONSTRAINT "agent_notices_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_notices" ADD CONSTRAINT "agent_notices_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_notices" ADD CONSTRAINT "agent_notices_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_notices" ADD CONSTRAINT "agent_notices_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_ladder_steps" ADD CONSTRAINT "loan_ladder_steps_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_ladder_steps" ADD CONSTRAINT "loan_ladder_steps_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_notices_agent_idx" ON "agent_notices" USING btree ("world_id","agent_id","read_at");--> statement-breakpoint
CREATE INDEX "agent_notices_principal_idx" ON "agent_notices" USING btree ("world_id","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_ladder_steps_loan_step_idx" ON "loan_ladder_steps" USING btree ("world_id","loan_id","step");--> statement-breakpoint
CREATE UNIQUE INDEX "loans_one_open_per_agent_idx" ON "loans" USING btree ("world_id","agent_id") WHERE "loans"."status" in ('accepted', 'disbursing', 'active', 'late', 'substandard');--> statement-breakpoint
-- Ruling P4-A: the main world's clock runs in real time (speed 1) so due
-- dates pass for demos. Re-anchor at now, preserving its current sim time
-- (anchor_sim + elapsed × speed + manual offset), with the offset folded in.
UPDATE "clock" SET
	"anchor_sim" = "clock"."anchor_sim"
		+ ((now() - "clock"."anchor_real") * "clock"."speed"::float8)
		+ ("clock"."manual_offset_ms" * interval '1 millisecond'),
	"anchor_real" = now(),
	"manual_offset_ms" = 0,
	"speed" = 1
FROM "worlds"
WHERE "worlds"."id" = "clock"."world_id" AND "worlds"."slug" = 'main' AND "clock"."speed" <> 1;
