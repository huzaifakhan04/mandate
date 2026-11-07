CREATE TABLE "elastic_cursors" (
	"world_id" uuid NOT NULL,
	"stream" text NOT NULL,
	"cursor_at" timestamp with time zone,
	"cursor_id" text,
	"shipped" bigint DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"principal_id" uuid,
	"kind" text NOT NULL,
	"window_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"evidence" jsonb NOT NULL,
	"first_sim_at" timestamp with time zone NOT NULL,
	"last_evidence_sim_at" timestamp with time zone NOT NULL,
	"case_file" jsonb,
	"investigation_claimed_at" timestamp with time zone,
	"ai_run_id" uuid,
	"owner_note" text,
	"review_requested_at" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	"cleared_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_flags_status" CHECK ("risk_flags"."status" in ('open', 'cleared'))
);
--> statement-breakpoint
ALTER TABLE "elastic_cursors" ADD CONSTRAINT "elastic_cursors_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_flags" ADD CONSTRAINT "risk_flags_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_flags" ADD CONSTRAINT "risk_flags_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_flags" ADD CONSTRAINT "risk_flags_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_flags" ADD CONSTRAINT "risk_flags_ai_run_id_ai_runs_id_fk" FOREIGN KEY ("ai_run_id") REFERENCES "public"."ai_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "elastic_cursors_world_stream_idx" ON "elastic_cursors" USING btree ("world_id","stream");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_flags_agent_kind_window_idx" ON "risk_flags" USING btree ("world_id","agent_id","kind","window_key");--> statement-breakpoint
CREATE INDEX "risk_flags_world_status_idx" ON "risk_flags" USING btree ("world_id","status");