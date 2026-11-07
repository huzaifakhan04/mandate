CREATE TABLE "loan_installments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"due_on" timestamp with time zone NOT NULL,
	"original_due_on" timestamp with time zone NOT NULL,
	"amount_cents" bigint NOT NULL,
	"paid_cents" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"moves" integer DEFAULT 0 NOT NULL,
	"auto_reschedule" boolean DEFAULT false NOT NULL,
	"auto_moved" boolean DEFAULT false NOT NULL,
	"plan_event_seq" bigint NOT NULL,
	"planned_total_cents" bigint NOT NULL,
	"paid_sim_at" timestamp with time zone,
	"missed_sim_at" timestamp with time zone,
	"failed_sim_at" timestamp with time zone,
	"failure_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loan_installments" ADD CONSTRAINT "loan_installments_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_installments" ADD CONSTRAINT "loan_installments_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_installments" ADD CONSTRAINT "loan_installments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_installments_loan_seq_idx" ON "loan_installments" USING btree ("world_id","loan_id","seq");--> statement-breakpoint
CREATE INDEX "loan_installments_status_idx" ON "loan_installments" USING btree ("world_id","status");