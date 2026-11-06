ALTER TABLE "paypal_operations" ALTER COLUMN "status" SET DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE "paypal_operations" ADD COLUMN "executable_request" jsonb;--> statement-breakpoint
ALTER TABLE "paypal_operations" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paypal_operations" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paypal_operations" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "paypal_operations" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "paypal_operations" ADD COLUMN "sim_state" jsonb;--> statement-breakpoint
-- Data migration: map P0 status values onto the queued-operation vocabulary.
-- P0 'pending'/'failed' rows have no executable_request to replay, so they
-- can only be terminal; P0 'succeeded' keeps its value unchanged.
UPDATE "paypal_operations" SET "status" = 'failed_terminal' WHERE "status" IN ('failed', 'pending');
