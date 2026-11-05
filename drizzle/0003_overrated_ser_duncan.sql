ALTER TABLE "paypal_operations" ALTER COLUMN "status" SET DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE "paypal_operations" ADD COLUMN "executable_request" jsonb;--> statement-breakpoint
ALTER TABLE "paypal_operations" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paypal_operations" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paypal_operations" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "paypal_operations" ADD COLUMN "source_id" text;