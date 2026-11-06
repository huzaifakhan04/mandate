CREATE TABLE "loan_holder_losses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"loss_cents" bigint NOT NULL,
	"recovered_cents" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "charge_off_principal_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "charge_off_total_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "holders_loss_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "recovered_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repayments" ADD COLUMN "applied_recovery_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_holder_losses" ADD CONSTRAINT "loan_holder_losses_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_holder_losses" ADD CONSTRAINT "loan_holder_losses_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_holder_losses" ADD CONSTRAINT "loan_holder_losses_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_holder_losses_loan_agent_idx" ON "loan_holder_losses" USING btree ("world_id","loan_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repayment_links_one_guarantee_per_loan_idx" ON "repayment_links" USING btree ("world_id","loan_id") WHERE "repayment_links"."kind" = 'guarantee';