ALTER TABLE "applications" ADD COLUMN "adverse_action" jsonb;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "narrative" jsonb;--> statement-breakpoint
ALTER TABLE "kya_documents" ADD COLUMN "ai_verdict" text;--> statement-breakpoint
ALTER TABLE "kya_documents" ADD COLUMN "ai_findings" jsonb;