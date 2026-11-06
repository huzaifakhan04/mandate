ALTER TABLE "loans" ADD COLUMN "waived_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repayment_links" ADD COLUMN "quote_sim_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repayment_links" ADD COLUMN "quoted_cents" bigint;