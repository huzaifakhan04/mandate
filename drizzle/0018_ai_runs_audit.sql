ALTER TABLE "ai_runs" ADD COLUMN "input_hash" text;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "tokens_in" integer;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "tokens_out" integer;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "error_code" text;