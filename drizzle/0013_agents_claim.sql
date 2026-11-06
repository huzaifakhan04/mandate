ALTER TABLE "agents" ADD COLUMN "claim_token_seed" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_claim_token_hash_idx" ON "agents" USING btree ("claim_token_hash");