DROP INDEX "job_runs_world_job_day_idx";--> statement-breakpoint
ALTER TABLE "job_runs" ALTER COLUMN "sim_day" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "output" jsonb;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "job_runs_world_job_day_idx" ON "job_runs" USING btree ("world_id","job","sim_day") WHERE "job_runs"."sim_day" is not null;