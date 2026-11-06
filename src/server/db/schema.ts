import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
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

/**
 * Postgres `bytea` (P2 Ruling P2-A: KYA documents live in Postgres, ≤ 2 MB).
 * Drivers hand back a `Buffer` (node-postgres/Neon) or a `Uint8Array`
 * (PGlite); both are normalised to a `Buffer`.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType() {
    return "bytea";
  },
  fromDriver(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  },
});

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
  /**
   * P2 Task 6: `main` (the shared world, and P1's test worlds) or
   * `private` (a principal's sandbox world: sim rail only, seeded bots,
   * clock controls; never reachable from main-world reads).
   */
  kind: text("kind").notNull().default("main"),
  /** P2 Task 6: the system principal that owns this private world's borrower bots. */
  botPrincipalId: uuid("bot_principal_id").references(() => principals.id),
  /** P2 Task 6: the bots' RNG seed (defaults to the world id); same seed → same bot behaviour. */
  botSeed: text("bot_seed"),
  /** P2 Task 6: the last simulated day (since the clock's anchor) the bots have acted on. */
  lastBotSimDay: integer("last_bot_sim_day"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("worlds_owner_kind_idx").on(table.ownerPrincipalId, table.kind, table.status),
  // Review Focus 5: a private world is sim-only, at the row level too.
  check("worlds_private_is_sim", sql`${table.kind} <> 'private' OR ${table.railMode} = 'sim'`),
]);

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
  /** sha256 of the role's system prompt + output schema (the prompt version). */
  promptHash: text("prompt_hash").notNull(),
  /** Legacy P0 column; P3 uses `subject`. */
  inputRef: text("input_ref"),
  /** sha256 of the redacted, allowlisted input actually sent (P3 Task 3). */
  inputHash: text("input_hash"),
  /** What the run is about: an application id or a KYA document id. */
  subject: text("subject"),
  output: jsonb("output"),
  latencyMs: integer("latency_ms"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  fallbackUsed: boolean("fallback_used").notNull().default(false),
  /** Why the template was used: disabled, timeout, http_<status>, request_failed, invalid_json, schema_violation, policy_violation. */
  errorCode: text("error_code"),
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
  /** `queued | in_flight | succeeded | failed_retryable | failed_terminal`. */
  status: text("status").notNull().default("queued"),
  /** Redacted copy of the request, kept for audit/display. */
  request: jsonb("request"),
  /**
   * Unredacted `{ method, path, body }` this operation re-sends on every
   * `executeOperation` attempt — sandbox-only, and safe to store
   * unredacted because it never carries an auth header (the bearer
   * token is added by `paypalFetch` itself, never stored here).
   */
  executableRequest: jsonb("executable_request"),
  /**
   * The operation's parsed, JSON-safe result — one shape per kind (see
   * `paypal/types.ts`, amounts as decimal strings) on success, or
   * `{ error: … }` on failure. Exactly what `executeOperation` returns,
   * on the first run and on every replay.
   */
  response: jsonb("response"),
  httpStatus: integer("http_status"),
  latencyMs: integer("latency_ms"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  /**
   * Set when `executeOperation` claims this row (`queued`/
   * `failed_retryable` -> `in_flight`) and cleared when the attempt
   * records its outcome; an `in_flight` claim older than 3 minutes is
   * treated as abandoned (crashed worker) and can be re-claimed.
   */
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  /** Earliest time a `failed_retryable` row should be retried. */
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  /** Why this operation exists — see `OperationPurpose` in paypal/operationId.ts. */
  purpose: text("purpose"),
  /** The domain row (note/loan/repayment id, …) this operation is for. */
  sourceId: text("source_id"),
  /**
   * Sim rail only: the simulated PayPal-side object this operation
   * created (an order for `order.create`, a batch for `payout.send`) and
   * its lifecycle state (`simApprove` / capture move it along). Kept
   * apart from `response`, which is the operation's own immutable result.
   */
  simState: jsonb("sim_state"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /**
   * Task 10b fix round 3 (M2): last write to the row (set by Drizzle on
   * every `update()`), so the reconcile cron can list only recently capped
   * operations.
   */
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  // P0 carry-forward M6 / Task 8 M3: reads by PayPal id within a world
  // (order/payout poll throttles, order → create op lookups) …
  index("paypal_operations_world_kind_paypal_id_idx").on(table.worldId, table.kind, table.paypalId),
  // … and across worlds (a webhook's resource → its operation).
  index("paypal_operations_kind_paypal_id_idx").on(table.kind, table.paypalId),
  // Task 10b fix round 3 (M1): the reconcile cron's per-world scans of
  // non-final rows (due ops, retrying/capped anomalies) …
  index("paypal_operations_world_open_status_idx")
    .on(table.worldId, table.status)
    .where(sql`${table.status} in ('failed_retryable', 'failed_terminal', 'queued', 'in_flight')`),
  // … and of recent succeeded payout sends (fee polling / payout_fee_unknown).
  index("paypal_operations_world_kind_status_created_idx").on(
    table.worldId,
    table.kind,
    table.status,
    table.createdAt,
  ),
]);

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
  kyaTier: integer("kya_tier").notNull().default(0),
  status: text("status").notNull().default("pending"),
  /** sha256 hex of the claim token (P2 Task 2). Kept after the claim so the link resolves to "already claimed". */
  claimTokenHash: text("claim_token_hash"),
  /**
   * Random per-token seed: the token is HMAC(secret, agent id + seed), so
   * `get_status` can show the claim URL again without storing the token.
   * Nulled once claimed.
   */
  claimTokenSeed: text("claim_token_seed"),
  claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  payoutReceiver: text("payout_receiver"),
  payoutReceiverType: text("payout_receiver_type"),
  /** P2 Task 6: a seeded private-world bot (operator "Mandate bots", model "simulated"); acts only via the bot runner. */
  isBot: boolean("is_bot").notNull().default(false),
  /**
   * P3 Task 1: the world's sim time at registration (score tenure). Null on
   * rows inserted outside `registerAgent` / the bot seeder; the scorecard
   * then falls back to `created_at`.
   */
  registeredSimAt: timestamp("registered_sim_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [uniqueIndex("agents_claim_token_hash_idx").on(table.claimTokenHash)]);

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
  /** Legacy P0 (Vercel Blob); unused since Ruling P2-A stores `content` inline. */
  blobUrl: text("blob_url"),
  sha256: text("sha256").notNull(),
  /** The file itself (P2 Task 3): pdf/png/jpg, ≤ 2 MB, type checked by magic bytes. */
  content: bytea("content"),
  /** The detected (magic-byte) media type: application/pdf, image/png or image/jpeg. */
  contentType: text("content_type"),
  sizeBytes: integer("size_bytes"),
  fileName: text("file_name"),
  aiReview: jsonb("ai_review"),
  reviewStatus: text("review_status").notNull().default("pending"),
  /** P3 Task 4: the KYA desk's advisory verdict (approve | needs_info | reject); `review_status` stays authoritative. */
  aiVerdict: text("ai_verdict"),
  /** P3 Task 4: the KYA desk's findings (plain text, URLs stripped, ≤ 200 chars each). */
  aiFindings: jsonb("ai_findings"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * An agent's Ed25519 request-signing key (P2 Task 3). At most one active
 * (unrevoked) key per agent; registering another revokes the old one.
 * Having an active key is one of the T2 requirements, and once one exists
 * every mutating call from that agent must be signed by it.
 */
export const agentKeys = pgTable(
  "agent_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    /** The raw 32-byte public key, base64. */
    publicKey: text("public_key").notNull(),
    alg: text("alg").notNull().default("ed25519"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("agent_keys_one_active_idx")
      .on(table.agentId)
      .where(sql`${table.revokedAt} is null`),
  ],
);

/**
 * Seen request signatures (P2 Task 3, replay protection). A signature is
 * valid for ±300 s around its timestamp, so a row only has to outlive
 * that 10-minute window; the reconcile cron prunes older rows.
 */
export const agentSignatureNonces = pgTable(
  "agent_signature_nonces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    /** The signature bytes, re-encoded as standard base64. */
    signature: text("signature").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("agent_signature_nonces_agent_signature_idx").on(table.agentId, table.signature),
    index("agent_signature_nonces_seen_at_idx").on(table.seenAt),
  ],
);

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
  /** P2 Task 4: optional end of the mandate's validity. */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /** `signed` (the current version) | `superseded` (a newer version was signed) | `revoked`. */
  status: text("status").notNull().default("signed"),
  /** The typed full name the human signed with. */
  signerName: text("signer_name"),
  /** sha256(IP + SESSION_SECRET) of the signing request. */
  ipHash: text("ip_hash"),
  /** sha256 of the canonical JSON of the signed terms (see `domain/mandate.ts`). */
  termsHash: text("terms_hash"),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  signature: jsonb("signature"),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  uniqueIndex("mandates_agent_version_idx").on(table.agentId, table.version),
  // At most one current (signed) version per agent.
  uniqueIndex("mandates_one_signed_per_agent_idx")
    .on(table.agentId)
    .where(sql`${table.status} = 'signed'`),
]);

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
  /** P3 Task 4: the adverse-action notice of a DECLINED application (reasons, score, notice, explanation). */
  adverseAction: jsonb("adverse_action"),
  /** P3 Task 4: the after-commit narrative — explanation (loan officer), memo (risk officer), ai_run ids. */
  narrative: jsonb("narrative"),
  /** The loan officer's `ai_runs` row for this application (P3 Task 4). */
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

export const loans = pgTable(
  "loans",
  {
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
    // Task 6: when the disbursement payout SUCCEEDED (sim time). `due_sim_at`
    // is re-based on it (disbursed + term) at activation.
    disbursedSimAt: timestamp("disbursed_sim_at", { withTimezone: true }),
    /**
     * P4 Task 1 (delinquency ladder). Late fees and the rate penalty are
     * memo balances: assessed here with no journal, recognised as
     * `late_fee_income` / `penalty_income` when a repayment collects them
     * (P1 convention: fee income is booked on collection). `late_fees_cents`
     * (P0) is the total late fee ever assessed; `outstanding_cents` stays
     * the base principal + fee still owed.
     */
    lateFeeOutstandingCents: bigint("late_fee_outstanding_cents", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** Total rate penalty accrued (whole days late through `penalty_accrued_days`). */
    penaltyCents: bigint("penalty_cents", { mode: "bigint" }).notNull().default(sql`0`),
    penaltyOutstandingCents: bigint("penalty_outstanding_cents", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** Days late the penalty has been accrued through (0 = not started). */
    penaltyAccruedDays: integer("penalty_accrued_days").notNull().default(0),
    /** The last ladder step applied: null | `late` | `penalty` | `substandard` | `charged_off`. */
    delinquencyStep: text("delinquency_step"),
    /**
     * P4 Task 2 (charge-off at +10). `charge_off_principal_cents` is the
     * principal written off (journaled: provision → allowance → loans
     * receivable); `charge_off_total_cents` is everything owed at that
     * moment — principal + base fee + late fees + penalty (the fees were
     * memo balances, so they are simply written off) — and the amount of
     * the principal's guarantee. `holders_loss_cents` is the part of the
     * principal loss the note holders bore (≤ principal; the bank's capital
     * absorbs the rest). `recovered_cents` is what payments after the
     * charge-off have recovered (≤ `charge_off_total_cents`; equal → status
     * `recovered`).
     */
    chargeOffPrincipalCents: bigint("charge_off_principal_cents", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    chargeOffTotalCents: bigint("charge_off_total_cents", { mode: "bigint" }).notNull().default(sql`0`),
    holdersLossCents: bigint("holders_loss_cents", { mode: "bigint" }).notNull().default(sql`0`),
    recoveredCents: bigint("recovered_cents", { mode: "bigint" }).notNull().default(sql`0`),
    /**
     * P4 fix round 1 (Ruling P4-C): late fees / penalty waived because a
     * full-payoff quote was paid as quoted after they were assessed or
     * accrued (memo balances, so no journal).
     */
    waivedCents: bigint("waived_cents", { mode: "bigint" }).notNull().default(sql`0`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Task 6: DB backstop for "one open loan per agent" (P1), under the
    // application-level check `accept_offer` makes while holding the note
    // series row lock. Keep the status list in sync with
    // `OPEN_LOAN_DB_STATUSES` in domain/loanMachine.ts (P4: late and
    // substandard loans are still open).
    uniqueIndex("loans_one_open_per_agent_idx")
      .on(table.worldId, table.agentId)
      .where(sql`${table.status} in ('accepted', 'disbursing', 'active', 'late', 'substandard')`),
  ],
);

/**
 * P4 Task 1: one row per delinquency ladder step applied to a loan — the
 * exactly-once key `(world_id, loan_id, step)`. Each step inserts its row
 * (ON CONFLICT DO NOTHING) in the same transaction as its effects, under
 * the series → loan locks, so a concurrent tick and manual advance (or a
 * retry after a crash) apply it once.
 */
export const loanLadderSteps = pgTable(
  "loan_ladder_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loans.id),
    step: text("step").notNull(),
    /** The sim time the step fell due (due_sim_at + its day offset). */
    dueSimAt: timestamp("due_sim_at", { withTimezone: true }).notNull(),
    /** The sim time it was applied. */
    appliedSimAt: timestamp("applied_sim_at", { withTimezone: true }).notNull(),
    /** Step-specific amounts (e.g. the late fee), for audit. */
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("loan_ladder_steps_loan_step_idx").on(table.worldId, table.loanId, table.step)],
);

/**
 * P4 Task 2: each note holder's share of a charged-off loan's principal
 * loss (Ruling P4-D: deferred while reserved by a pending redemption) (Dr `notes_payable[holder]` / Cr `provision_expense`, units reduced
 * by the same amount — Ruling T), and how much of it recoveries have
 * credited back (`recovered_cents` ≤ `loss_cents`). Written under the
 * loan row lock only (charge-off step, recovery capture).
 */
export const loanHolderLosses = pgTable(
  "loan_holder_losses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loans.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    /** The loss this holder has borne so far (units already reduced by it). */
    lossCents: bigint("loss_cents", { mode: "bigint" }).notNull(),
    recoveredCents: bigint("recovered_cents", { mode: "bigint" }).notNull().default(sql`0`),
    /**
     * Ruling P4-D: the part of this holder's share (computed on FULL units)
     * that couldn't be cut at charge-off because those units were reserved
     * by a pending redemption. Applied (→ `loss_cents`) if that redemption
     * fails; absorbed by the bank's capital (→ 0, nothing journaled) if it
     * succeeds. Never more than the holder's pending redemptions.
     */
    deferredCents: bigint("deferred_cents", { mode: "bigint" }).notNull().default(sql`0`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("loan_holder_losses_loan_agent_idx").on(table.worldId, table.loanId, table.agentId)],
);

/**
 * P4 Task 1: notices to an agent and its owner (late, penalty,
 * substandard, cured…). One row is visible to both: the agent through
 * `get_status` / `get_loan` (`read_at` = the agent acknowledged it with
 * `ack_notices`), the owner (`principal_id`) on the dashboard.
 */
export const agentNotices = pgTable(
  "agent_notices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    principalId: uuid("principal_id").references(() => principals.id),
    kind: text("kind").notNull(),
    loanId: uuid("loan_id").references(() => loans.id),
    simAt: timestamp("sim_at", { withTimezone: true }).notNull(),
    body: text("body").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    /** P4 Task 4: the owner's read state in the dashboard (separate from the agent's ack, `read_at`). */
    ownerReadAt: timestamp("owner_read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("agent_notices_agent_idx").on(table.worldId, table.agentId, table.readAt),
    index("agent_notices_principal_idx").on(table.worldId, table.principalId),
  ],
);

/**
 * Task 7: a repayment checkout for a loan — `kind` `invoice` (the payment
 * link the borrower's client pays; one per loan, created on activation,
 * its `order.create` keyed by the loan id), `direct` (one per
 * `repay_loan` call, its `order.create` keyed by this row's id) or (P4
 * Task 2) `guarantee` (the principal's guarantee, invoked at charge-off:
 * one per loan, its `order.create` purpose `guarantee` keyed by the loan id).
 * `status`: `pending` (order not created yet) → `open` (approve URL
 * known) → `paid` (capture applied) | `review` (captured amount mismatch)
 * | `failed`.
 */
export const repaymentLinks = pgTable(
  "repayment_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loans.id),
    // Task 7: null until the queued `order.create` has executed.
    paypalOrderId: text("paypal_order_id"),
    kind: text("kind").notNull(),
    amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
    payerHint: text("payer_hint"),
    status: text("status").notNull().default("pending"),
    createOpId: uuid("create_op_id").references(() => paypalOperations.id),
    /**
     * P4 fix round 1 (Ruling P4-C): a quoted link — `repay_loan` for the
     * full total due, or the guarantee — records the sim time of the quote
     * and the total due it quoted. Paying it as quoted settles the loan:
     * the penalty accrues only up to `quote_sim_at`, and anything assessed
     * or accrued after it is waived. Null for invoice links and partial
     * `repay_loan` amounts.
     */
    quoteSimAt: timestamp("quote_sim_at", { withTimezone: true }),
    quotedCents: bigint("quoted_cents", { mode: "bigint" }),
    approveUrl: text("approve_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One invoice link per loan (DB backstop under the activation hook,
    // which only runs once per activation).
    uniqueIndex("repayment_links_one_invoice_per_loan_idx")
      .on(table.worldId, table.loanId)
      .where(sql`${table.kind} = 'invoice'`),
    // P4 Task 2: one guarantee link per loan (the charge-off step runs once).
    uniqueIndex("repayment_links_one_guarantee_per_loan_idx")
      .on(table.worldId, table.loanId)
      .where(sql`${table.kind} = 'guarantee'`),
  ],
);

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
  /** P4 Task 2: what this payment recovered on a charged-off loan (Cr `recoveries_income`). */
  appliedRecoveryCents: bigint("applied_recovery_cents", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  /** P4 Task 1: the rate penalty this repayment collected (Cr `penalty_income`). */
  appliedPenaltyCents: bigint("applied_penalty_cents", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  remainderCents: bigint("remainder_cents", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  remainderPayoutOpId: uuid("remainder_payout_op_id").references(
    () => paypalOperations.id,
  ),
  // Task 7: the PayPal capture this repayment applied — unique per world,
  // so one capture can never be applied twice (ALREADY_CAPTURED recovery
  // returns an existing capture as a success).
  captureId: text("capture_id"),
  linkId: uuid("link_id").references(() => repaymentLinks.id),
  /**
   * Task 7: `none` (no remainder) | `pending` (payout queued/in flight,
   * or UNCLAIMED being cancelled) | `paid` | `failed` (stays owed in
   * `payable_to_borrower[agent]`) | `held` (no payout receiver on file).
   */
  remainderStatus: text("remainder_status").notNull().default("none"),
  remainderFailureReason: text("remainder_failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  uniqueIndex("repayments_world_capture_idx").on(table.worldId, table.captureId),
]);

export const noteSeries = pgTable(
  "note_series",
  {
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
  },
  (table) => [
    // One series per (world, name) — lets `ensureNoteSeries` (Task 4) seed
    // the world's single "Mandate Pool A" series with an `ON CONFLICT DO
    // NOTHING` insert that's race-safe the same way `worlds.slug` and
    // `clock.worldId` already are.
    uniqueIndex("note_series_world_name_idx").on(table.worldId, table.name),
  ],
);

export const notePositions = pgTable(
  "note_positions",
  {
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
  },
  (table) => [
    // One position per (series, agent) — lets `getOrCreatePosition`
    // (Task 5) upsert with `ON CONFLICT DO NOTHING` instead of a
    // select-then-insert race.
    uniqueIndex("note_positions_series_agent_idx").on(table.seriesId, table.agentId),
    // Fix round 1 (C1): a last-resort DB-level backstop against a
    // double-redemption ever driving units negative, on top of the
    // application-level "redeemable = units - pending redemptions" check.
    check("note_positions_units_nonnegative", sql`${table.units} >= 0`),
  ],
);

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
  /**
   * `pending | completed | failed` (Task 5). A `buy` starts `pending`
   * and moves to `completed` exactly once, on the note-purchase
   * capture's effect (conditional `pending -> completed` update, guarding
   * the journal + position-units increment against a double-apply on
   * replay). A `redeem` starts `pending` and moves to `completed` on a
   * SUCCEEDED payout or `failed` on a FAILED/UNCLAIMED/etc. payout item.
   */
  status: text("status").notNull().default("pending"),
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
    // Nullable: a claim-first insert writes the row with `response`/
    // `http_status` both null to reserve `(world_id, agent_id, key)` before
    // the handler runs, then fills them in with an UPDATE in the same
    // transaction once the handler succeeds. A row is never visible to
    // another transaction until it commits with both fields set — see
    // runTool.ts's claim-first idempotency comment for the full protocol.
    response: jsonb("response"),
    httpStatus: integer("http_status"),
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
    /**
     * The simulated day a once-per-sim-day job (P4) ran for — unique per
     * (world, job) when set. Task 8's every-minute crons (`reconcile`,
     * `tick`) leave it null and write one row per world per run.
     */
    simDay: integer("sim_day"),
    /** Task 8: the run's counts, errors and anomalies (JSON-safe). */
    output: jsonb("output"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("job_runs_world_job_day_idx")
      .on(table.worldId, table.job, table.simDay)
      .where(sql`${table.simDay} is not null`),
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
  /** P3 Task 1: `{identity, history, tenure, collateral, exposure}` points. */
  components: jsonb("components"),
  /** P3 Task 1: the top-3 human-readable score factors. */
  factors: jsonb("factors"),
  updatedSimAt: timestamp("updated_sim_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  // P3 Task 1: one current score per subject (score_history keeps the trail).
  uniqueIndex("credit_scores_subject_idx").on(table.worldId, table.subjectType, table.subjectId),
]);

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
  /** P3 Task 1: the score recorded, its grade and component breakdown. */
  score: integer("score"),
  grade: text("grade"),
  components: jsonb("components"),
  /** P3 Task 1: the application this score was recorded for (if any). */
  applicationId: uuid("application_id").references(() => applications.id),
  simAt: timestamp("sim_at", { withTimezone: true }),
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
