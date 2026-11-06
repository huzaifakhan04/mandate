ALTER TABLE "agents" ADD COLUMN "is_bot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "kind" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "bot_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "bot_seed" text;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "last_bot_sim_day" integer;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "worlds" ADD CONSTRAINT "worlds_bot_principal_id_principals_id_fk" FOREIGN KEY ("bot_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "worlds_owner_kind_idx" ON "worlds" USING btree ("owner_principal_id","kind","status");--> statement-breakpoint
ALTER TABLE "worlds" ADD CONSTRAINT "worlds_private_is_sim" CHECK ("worlds"."kind" <> 'private' OR "worlds"."rail_mode" = 'sim');