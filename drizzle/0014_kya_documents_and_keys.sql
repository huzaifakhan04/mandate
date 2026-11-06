CREATE TABLE "agent_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"alg" text DEFAULT 'ed25519' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_signature_nonces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"signature" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kya_documents" ALTER COLUMN "blob_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kya_documents" ADD COLUMN "content" "bytea";--> statement-breakpoint
ALTER TABLE "kya_documents" ADD COLUMN "content_type" text;--> statement-breakpoint
ALTER TABLE "kya_documents" ADD COLUMN "size_bytes" integer;--> statement-breakpoint
ALTER TABLE "kya_documents" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_signature_nonces" ADD CONSTRAINT "agent_signature_nonces_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_signature_nonces" ADD CONSTRAINT "agent_signature_nonces_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_keys_one_active_idx" ON "agent_keys" USING btree ("agent_id") WHERE "agent_keys"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_signature_nonces_agent_signature_idx" ON "agent_signature_nonces" USING btree ("agent_id","signature");--> statement-breakpoint
CREATE INDEX "agent_signature_nonces_seen_at_idx" ON "agent_signature_nonces" USING btree ("seen_at");--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "ed25519_pubkey";