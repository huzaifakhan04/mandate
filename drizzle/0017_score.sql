ALTER TABLE "agents" ADD COLUMN "registered_sim_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_scores" ADD COLUMN "components" jsonb;--> statement-breakpoint
ALTER TABLE "credit_scores" ADD COLUMN "factors" jsonb;--> statement-breakpoint
ALTER TABLE "score_history" ADD COLUMN "score" integer;--> statement-breakpoint
ALTER TABLE "score_history" ADD COLUMN "grade" text;--> statement-breakpoint
ALTER TABLE "score_history" ADD COLUMN "components" jsonb;--> statement-breakpoint
ALTER TABLE "score_history" ADD COLUMN "application_id" uuid;--> statement-breakpoint
ALTER TABLE "score_history" ADD COLUMN "sim_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "score_history" ADD CONSTRAINT "score_history_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_scores_subject_idx" ON "credit_scores" USING btree ("world_id","subject_type","subject_id");--> statement-breakpoint
-- Backfill: P0–P2 agents predate the column; their real creation time is the best sim estimate (main-world clocks run at real time).
UPDATE "agents" SET "registered_sim_at" = "created_at" WHERE "registered_sim_at" IS NULL;