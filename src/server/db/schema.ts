import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// -----------------------------------------------------------------------
// Root / unscoped tables
// -----------------------------------------------------------------------

export const principals = pgTable("principals", {
  id: uuid("id").primaryKey().defaultRandom(),
  paypalPayerId: text("paypal_payer_id").unique(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  entityType: text("entity_type").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  kycStatus: text("kyc_status").notNull().default("pending"),
  sanctionsStatus: text("sanctions_status").notNull().default("pending"),
  aggregateLimitCents: bigint("aggregate_limit_cents", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const worlds = pgTable("worlds", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  ownerPrincipalId: uuid("owner_principal_id").references(
    () => principals.id,
  ),
  railMode: text("rail_mode").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// -----------------------------------------------------------------------
// World-scoped tables with no further internal dependencies
// -----------------------------------------------------------------------

export const aiRuns = pgTable("ai_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  role: text("role").notNull(),
  model: text("model").notNull(),
  promptHash: text("prompt_hash").notNull(),
  inputRef: text("input_ref"),
  output: jsonb("output"),
  latencyMs: integer("latency_ms"),
  fallbackUsed: boolean("fallback_used").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const paypalOperations = pgTable("paypal_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  rail: text("rail").notNull(),
  kind: text("kind").notNull(),
  requestId: text("request_id").notNull(),
  paypalId: text("paypal_id"),
  status: text("status").notNull().default("pending"),
  request: jsonb("request"),
  response: jsonb("response"),
  httpStatus: integer("http_status"),
  latencyMs: integer("latency_ms"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const clock = pgTable("clock", {
  worldId: uuid("world_id")
    .primaryKey()
    .references(() => worlds.id),
  anchorReal: timestamp("anchor_real", { withTimezone: true }).notNull(),
  anchorSim: timestamp("anchor_sim", { withTimezone: true }).notNull(),
  speed: numeric("speed", { precision: 10, scale: 4 }).notNull().default("0"),
  manualOffsetMs: bigint("manual_offset_ms", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const worldMemberships = pgTable("world_memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  principalId: uuid("principal_id")
    .notNull()
    .references(() => principals.id),
  role: text("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  principalId: uuid("principal_id").references(() => principals.id),
  name: text("name").notNull(),
  operator: text("operator").notNull(),
  model: text("model").notNull(),
  codeManifestHash: text("code_manifest_hash").notNull(),
  ed25519Pubkey: text("ed25519_pubkey"),
  kyaTier: integer("kya_tier").notNull().default(0),
  status: text("status").notNull().default("pending"),
  claimTokenHash: text("claim_token_hash"),
  claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
  payoutReceiver: text("payout_receiver"),
  payoutReceiverType: text("payout_receiver_type"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  prefix: text("prefix").notNull().unique(),
  keyHash: text("key_hash").notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const kyaDocuments = pgTable("kya_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  principalId: uuid("principal_id")
    .notNull()
    .references(() => principals.id),
  kind: text("kind").notNull(),
  blobUrl: text("blob_url").notNull(),
  sha256: text("sha256").notNull(),
  aiReview: jsonb("ai_review"),
  reviewStatus: text("review_status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const mandates = pgTable("mandates", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  principalId: uuid("principal_id")
    .notNull()
    .references(() => principals.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  version: integer("version").notNull().default(1),
  maxPerLoanCents: bigint("max_per_loan_cents", { mode: "bigint" }).notNull(),
  maxTotalOwedCents: bigint("max_total_owed_cents", {
    mode: "bigint",
  }).notNull(),
  eligibleCollateral: text("eligible_collateral").array().notNull(),
  maxFeeBps: integer("max_fee_bps").notNull(),
  maxTermDays: integer("max_term_days").notNull(),
  guaranteeTextHash: text("guarantee_text_hash").notNull(),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  signature: jsonb("signature"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const applications = pgTable("applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  mandateId: uuid("mandate_id").references(() => mandates.id),
  amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
  termDays: integer("term_days").notNull(),
  purpose: text("purpose").notNull(),
  invoiceRef: jsonb("invoice_ref"),
  sections: jsonb("sections"),
  status: text("status").notNull().default("pending"),
  decision: text("decision"),
  reasonCodes: text("reason_codes").array(),
  scorecard: jsonb("scorecard"),
  aiRunId: uuid("ai_run_id").references(() => aiRuns.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const offers = pgTable("offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  applicationId: uuid("application_id")
    .notNull()
    .references(() => applications.id),
  principalCents: bigint("principal_cents", { mode: "bigint" }).notNull(),
  feeCents: bigint("fee_cents", { mode: "bigint" }).notNull(),
  aprBps: integer("apr_bps").notNull(),
  termDays: integer("term_days").notNull(),
  dueSimAt: timestamp("due_sim_at", { withTimezone: true }).notNull(),
  disclosure: jsonb("disclosure"),
  disclosureHash: text("disclosure_hash").notNull(),
  expiresSimAt: timestamp("expires_sim_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("pending"),
  acceptedAckHash: text("accepted_ack_hash"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const loans = pgTable("loans", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  offerId: uuid("offer_id")
    .notNull()
    .references(() => offers.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  principalId: uuid("principal_id").references(() => principals.id),
  principalCents: bigint("principal_cents", { mode: "bigint" }).notNull(),
  feeCents: bigint("fee_cents", { mode: "bigint" }).notNull(),
  lateFeesCents: bigint("late_fees_cents", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  outstandingCents: bigint("outstanding_cents", { mode: "bigint" }).notNull(),
  dueSimAt: timestamp("due_sim_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("active"),
  dpd: integer("dpd").notNull().default(0),
  riskGrade: text("risk_grade"),
  disbursementOpId: uuid("disbursement_op_id").references(
    () => paypalOperations.id,
  ),
  chargedOffAt: timestamp("charged_off_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const repaymentLinks = pgTable("repayment_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  loanId: uuid("loan_id")
    .notNull()
    .references(() => loans.id),
  paypalOrderId: text("paypal_order_id").notNull(),
  kind: text("kind").notNull(),
  amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
  payerHint: text("payer_hint"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const repayments = pgTable("repayments", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  loanId: uuid("loan_id")
    .notNull()
    .references(() => loans.id),
  opId: uuid("op_id")
    .notNull()
    .references(() => paypalOperations.id),
  grossCents: bigint("gross_cents", { mode: "bigint" }).notNull(),
  appliedPrincipalCents: bigint("applied_principal_cents", {
    mode: "bigint",
  }).notNull(),
  appliedFeeCents: bigint("applied_fee_cents", { mode: "bigint" }).notNull(),
  appliedLateFeeCents: bigint("applied_late_fee_cents", {
    mode: "bigint",
  }).notNull(),
  remainderCents: bigint("remainder_cents", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  remainderPayoutOpId: uuid("remainder_payout_op_id").references(
    () => paypalOperations.id,
  ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const noteSeries = pgTable("note_series", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  name: text("name").notNull(),
  poolType: text("pool_type").notNull(),
  disclosure: jsonb("disclosure"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const notePositions = pgTable("note_positions", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  seriesId: uuid("series_id")
    .notNull()
    .references(() => noteSeries.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  units: bigint("units", { mode: "bigint" }).notNull(),
  costCents: bigint("cost_cents", { mode: "bigint" }).notNull(),
  accruedCents: bigint("accrued_cents", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const noteTransactions = pgTable("note_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  positionId: uuid("position_id")
    .notNull()
    .references(() => notePositions.id),
  kind: text("kind").notNull(),
  amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
  opId: uuid("op_id").references(() => paypalOperations.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    code: text("code").notNull(),
    type: text("type").notNull(),
    ownerRef: text("owner_ref"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // NULLS NOT DISTINCT: without it, Postgres treats every NULL
    // owner_ref as distinct, so two concurrent "create this top-level
    // account if it doesn't exist" calls could each insert a row for
    // the same (world_id, code, NULL) instead of the second one hitting
    // a conflict. A plain uniqueIndex() can't express NULLS NOT
    // DISTINCT in this drizzle-orm version, so this is a `unique(...)`
    // table constraint instead (same effective columns/name).
    unique("ledger_accounts_world_code_owner_idx")
      .on(table.worldId, table.code, table.ownerRef)
      .nullsNotDistinct(),
  ],
);

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    memo: text("memo"),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    simAt: timestamp("sim_at", { withTimezone: true }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("journal_entries_world_idempotency_idx").on(
      table.worldId,
      table.idempotencyKey,
    ),
  ],
);

export const postings = pgTable("postings", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  entryId: uuid("entry_id")
    .notNull()
    .references(() => journalEntries.id),
  accountId: uuid("account_id")
    .notNull()
    .references(() => ledgerAccounts.id),
  amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// webhook_events: world_id is nullable here (filled after correlation).
// This is the schema guard's documented exception.
export const webhookEvents = pgTable("webhook_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id").references(() => worlds.id),
  paypalEventId: text("paypal_event_id").notNull().unique(),
  type: text("type").notNull(),
  verified: boolean("verified").notNull().default(false),
  payload: jsonb("payload").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  seq: bigserial("seq", { mode: "bigint" }).notNull(),
  type: text("type").notNull(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  payload: jsonb("payload"),
  occurredSimAt: timestamp("occurred_sim_at", {
    withTimezone: true,
  }).notNull(),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idempotency_keys_world_agent_key_idx").on(
      table.worldId,
      table.agentId,
      table.key,
    ),
  ],
);

export const jobRuns = pgTable(
  "job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    job: text("job").notNull(),
    simDay: integer("sim_day").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("job_runs_world_job_day_idx").on(
      table.worldId,
      table.job,
      table.simDay,
    ),
  ],
);

export const creditScores = pgTable("credit_scores", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id").notNull(),
  score: integer("score").notNull(),
  grade: text("grade"),
  limitCents: bigint("limit_cents", { mode: "bigint" }).notNull().default(sql`0`),
  updatedSimAt: timestamp("updated_sim_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const scoreHistory = pgTable("score_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id").notNull(),
  delta: integer("delta").notNull(),
  reasonCode: text("reason_code").notNull(),
  sourceEventId: uuid("source_event_id").references(() => events.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const economyState = pgTable("economy_state", {
  id: uuid("id").primaryKey().defaultRandom(),
  worldId: uuid("world_id")
    .notNull()
    .references(() => worlds.id),
  simDay: integer("sim_day").notNull(),
  baseRateBps: integer("base_rate_bps").notNull(),
  inflationIndexBp: integer("inflation_index_bp").notNull(),
  utilizationBps: integer("utilization_bps").notNull(),
  reserveRatioBps: integer("reserve_ratio_bps").notNull(),
  ceclReserveCents: bigint("cecl_reserve_cents", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  roiBps: integer("roi_bps"),
  scenario: text("scenario"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
