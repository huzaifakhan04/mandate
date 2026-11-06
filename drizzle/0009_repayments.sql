ALTER TABLE "repayment_links" ALTER COLUMN "paypal_order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "repayment_links" ADD COLUMN "create_op_id" uuid;--> statement-breakpoint
ALTER TABLE "repayment_links" ADD COLUMN "approve_url" text;--> statement-breakpoint
ALTER TABLE "repayments" ADD COLUMN "capture_id" text;--> statement-breakpoint
ALTER TABLE "repayments" ADD COLUMN "link_id" uuid;--> statement-breakpoint
ALTER TABLE "repayments" ADD COLUMN "remainder_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "repayments" ADD COLUMN "remainder_failure_reason" text;--> statement-breakpoint
ALTER TABLE "repayment_links" ADD CONSTRAINT "repayment_links_create_op_id_paypal_operations_id_fk" FOREIGN KEY ("create_op_id") REFERENCES "public"."paypal_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayments" ADD CONSTRAINT "repayments_link_id_repayment_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."repayment_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repayment_links_one_invoice_per_loan_idx" ON "repayment_links" USING btree ("world_id","loan_id") WHERE "repayment_links"."kind" = 'invoice';--> statement-breakpoint
CREATE UNIQUE INDEX "repayments_world_capture_idx" ON "repayments" USING btree ("world_id","capture_id");