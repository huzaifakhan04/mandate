ALTER TABLE "mandates" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "status" text DEFAULT 'signed' NOT NULL;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "signer_name" text;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "ip_hash" text;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "terms_hash" text;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
UPDATE "mandates" SET "status" = 'revoked' WHERE "revoked_at" IS NOT NULL;--> statement-breakpoint
UPDATE "mandates" m SET "status" = 'superseded', "superseded_at" = now() WHERE m."status" = 'signed' AND EXISTS (SELECT 1 FROM "mandates" n WHERE n."agent_id" = m."agent_id" AND n."status" = 'signed' AND (n."version", n."created_at", n."id") > (m."version", m."created_at", m."id"));--> statement-breakpoint
CREATE UNIQUE INDEX "mandates_agent_version_idx" ON "mandates" USING btree ("agent_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "mandates_one_signed_per_agent_idx" ON "mandates" USING btree ("agent_id") WHERE "mandates"."status" = 'signed';