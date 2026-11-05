# P0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deployable skeleton for "Mandate — the bank for AI agents". It needs tooling and CI, the full Postgres schema with world isolation, a double-entry ledger, the bank clock, a PayPal sandbox client behind a payment-rail interface, and one agent tool (`get_bank_guide`) exposed through REST, MCP and OpenAPI from a single contract registry. It also needs PayPal spikes and a design pack for approval.

**Architecture:** Next.js App Router monolith. Pure logic lives in `src/server/**`. Route handlers are thin adapters, and every agent tool is defined once in a Zod contract registry that drives the REST routes, the MCP tools and `openapi.json`. Money moves through a `PaymentRail` interface with two implementations: real PayPal sandbox and a simulated rail.

**Tech Stack:**
- Next.js 16.4.5, React 19.3, TypeScript 5 (strict), Tailwind 4, npm
- drizzle-orm 0.45 + drizzle-kit 0.31; @neondatabase/serverless 1.2 in prod, @electric-sql/pglite 0.5 in tests
- zod 4; mcp-handler 2.3 (+ the `@modelcontextprotocol/server` 2.x peer it requires)
- vitest 5, fast-check 4, msw 3, @playwright/test 1.64, tsx 4

**Spec:** `docs/superpowers/specs/2026-11-05-mandate-design.md`. Domain facts are in `docs/research/agentic-bank-research.md`.

## Global Constraints
- **Money:** always integer **cents** (`bigint` in DB, `bigint` in TS domain code). Rates are integer **basis points**. Currency is USD only. Never use floats for money.
- **World isolation:** every table except `worlds` and `principals` has a non-null `world_id uuid` column. Unique indexes that involve business keys are prefixed with `world_id`.
- **PayPal endpoints:** sandbox base URL `https://api-m.sandbox.paypal.com`. Every mutating PayPal call sends a `PayPal-Request-Id` equal to the `paypal_operations.id` of that call. The PayPal Agent Toolkit is not used.
- **Secrets:** read only from `process.env`. Never commit `.env*`. Never log secrets, access tokens or full card or account data; PayPal request and response bodies are stored redacted.
- **Tests:** unit tests run without network or secrets. Tests that hit PayPal sandbox are wrapped in `describe.skipIf(!process.env.PAYPAL_CLIENT_ID)`.
- **Agent response envelope** (every tool): `{ status: string, summary: string, reason_codes: string[], data: object, next_actions: {tool: string, args: object}[], docs_url: string }`.
- **Product name:** "Mandate". MCP server name `mandate-bank`. Light theme only, using these tokens: background `#FFFFFF`, surface `#F6F7F9`, ink `#15181D`, accent (deep blue) `#1D4ED8`, money-in green `#0F9D58`, risk red `#D93025`.
- **Node:** `"engines": {"node": ">=20"}`. Use npm, not pnpm or bun.
- **Commits:** end every commit message with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QMRw6S4SGhdSe6WjBX9Cqg
  ```

## Review Focus
1. **The same journal idempotency key posted twice** (an agent retry) must produce exactly one journal entry and return the original. *Test in Task 3.*
2. **An unbalanced or empty posting set, or a zero-amount line,** must be rejected and nothing written. *Test in Task 3.*
3. **An expired PayPal access token** (401) must be refreshed once and the call retried with the **same** `PayPal-Request-Id`. A 5xx gets up to 2 retries with backoff, never a new request id. *Test in Task 5.*
4. **An invalid tool input** over REST or MCP must return the envelope with `status:"INVALID_REQUEST"` and HTTP 400; **an unknown tool** must return the envelope with `status:"NOT_FOUND"` and HTTP 404 — over MCP this is `tools/call` returning a normal tool result (`isError:true`) carrying that envelope, never a raw JSON-RPC error. Neither case is ever a 500 or stack trace. *Test in Task 6.*
5. **A query that runs without `scoped(worldId)`** could leak rows across worlds. The schema guard plus a test with two worlds must catch leakage. *Test in Task 2.*

---

### Task 1: Tooling, CI and design tokens

**Files:**
- Modify: `package.json` (scripts `test`, `test:watch`, `typecheck`, `e2e`, `db:generate`, `db:migrate`; engines), `tsconfig.json` (`strict: true`, `noUncheckedIndexedAccess: true`), `src/app/globals.css` (light theme CSS variables from Global Constraints; remove dark-mode media query), `src/app/page.tsx` (placeholder "Mandate — the bank for AI agents" landing)
- Create: `vitest.config.ts` (node env, `tests/unit/**` and `tests/integration/**`, `@/` alias), `playwright.config.ts` (`tests/e2e`, baseURL `http://localhost:3000`, webServer `npm run dev`), `.github/workflows/ci.yml` (Node 22: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`), `tests/unit/smoke.test.ts`, `tests/e2e/landing.spec.ts`, `.env.example` (every env var name used in P0, empty values)

**Interfaces:**
- Produces: `npm test`, `npm run typecheck`, `npm run e2e`.

- [ ] **Step 1:** Write `tests/unit/smoke.test.ts`, asserting `1 + 1 === 2`. Write `tests/e2e/landing.spec.ts` asserting the page has heading text `Mandate` and the body background computes to `rgb(255, 255, 255)`.
- [ ] **Step 2:** Install dev deps (vitest, @vitest/coverage-v8, @playwright/test, tsx, vite-tsconfig-paths) and run `npx playwright install chromium`. Add configs and scripts.
- [ ] **Step 3:** Run `npm test` (expect pass), `npm run typecheck` (expect 0 errors), `npm run lint` (expect 0 errors), `npm run e2e` (expect pass).
- [ ] **Step 4:** Commit `chore: tooling, CI, light theme tokens`.

### Task 2: Database schema, client and world scoping

**Files:**
- Create: `drizzle.config.ts`, `src/server/db/schema.ts` (all tables below), `src/server/db/client.ts`, `src/server/db/scoped.ts`, `src/server/db/testing.ts`, `drizzle/` (generated migrations), `tests/unit/db/schema-guard.test.ts`, `tests/unit/db/scoped.test.ts`

**Tables** (columns beyond `id uuid pk default gen_random_uuid()`, `world_id` where required, and `created_at timestamptz default now()`). These are created now so later phases don't conflict:

| Table | Columns |
|---|---|
| `worlds` | slug unique, name, owner_principal_id null, rail_mode text (`'paypal'` \| `'sim'` \| `'mixed'`), status |
| `clock` | world_id pk, anchor_real timestamptz, anchor_sim timestamptz, speed numeric default 0, manual_offset_ms bigint default 0 |
| `principals` | paypal_payer_id unique null, email, name, entity_type, verified_at, kyc_status, sanctions_status, aggregate_limit_cents bigint |
| `world_memberships` | world_id, principal_id, role |
| `agents` | principal_id null, name, operator, model, code_manifest_hash, ed25519_pubkey null, kya_tier int default 0, status, claim_token_hash null, claim_expires_at null, payout_receiver text null, payout_receiver_type text null |
| `api_keys` | agent_id, prefix unique, key_hash, last_used_at, revoked_at |
| `kya_documents` | agent_id, principal_id, kind, blob_url, sha256, ai_review jsonb, review_status |
| `mandates` | principal_id, agent_id, version int, max_per_loan_cents, max_total_owed_cents, eligible_collateral text[], max_fee_bps int, max_term_days int, guarantee_text_hash, signed_at, signature jsonb, revoked_at |
| `applications` | agent_id, mandate_id null, amount_cents, term_days, purpose, invoice_ref jsonb, sections jsonb, status, decision, reason_codes text[], scorecard jsonb, ai_run_id null |
| `offers` | application_id, principal_cents, fee_cents, apr_bps, term_days, due_sim_at, disclosure jsonb, disclosure_hash, expires_sim_at, status, accepted_ack_hash |
| `loans` | offer_id, agent_id, principal_id null, principal_cents, fee_cents, late_fees_cents default 0, outstanding_cents, due_sim_at, status, dpd int default 0, risk_grade, disbursement_op_id null, charged_off_at null |
| `repayment_links` | loan_id, paypal_order_id, kind, amount_cents, payer_hint, status |
| `repayments` | loan_id, op_id, gross_cents, applied_principal_cents, applied_fee_cents, applied_late_fee_cents, remainder_cents, remainder_payout_op_id |
| `note_series` | name, pool_type, disclosure jsonb |
| `note_positions` | series_id, agent_id, units bigint, cost_cents, accrued_cents, status |
| `note_transactions` | position_id, kind, amount_cents, op_id |
| `ledger_accounts` | code, type, owner_ref null; unique (world_id, code, owner_ref) |
| `journal_entries` | memo, source_type, source_id, sim_at, idempotency_key; unique (world_id, idempotency_key) |
| `postings` | entry_id, account_id, amount_cents bigint (signed) |
| `paypal_operations` | rail, kind, request_id, paypal_id, status, request jsonb, response jsonb, http_status, latency_ms, attempts, last_error |
| `webhook_events` | paypal_event_id unique, type, verified bool, payload jsonb, processed_at. world_id **nullable** here, filled after correlation; this is the guard's documented exception |
| `events` | seq bigserial, type, aggregate_type, aggregate_id, payload jsonb, occurred_sim_at, dispatched_at |
| `idempotency_keys` | agent_id, key, request_hash, response jsonb; unique (world_id, agent_id, key) |
| `job_runs` | job, sim_day; unique (world_id, job, sim_day) |
| `credit_scores` | subject_type, subject_id, score int, grade, limit_cents, updated_sim_at |
| `score_history` | subject_type, subject_id, delta int, reason_code, source_event_id |
| `economy_state` | sim_day, base_rate_bps, inflation_index_bp, utilization_bps, reserve_ratio_bps, cecl_reserve_cents, roi_bps, scenario |
| `ai_runs` | role, model, prompt_hash, input_ref, output jsonb, latency_ms, fallback_used bool |

**Interfaces:**
- Produces:
  - `db` (Drizzle instance, Neon in prod).
  - `type Db`.
  - `createTestDb(): Promise<Db>`: PGlite with migrations applied, in `testing.ts`.
  - `scoped(db: Db, worldId: string)`, which returns helpers that always add `world_id = worldId`: `.select(table)`, `.insert(table, values)` (sets world_id), `.update(table, set, where)`.
  - All table exports from `schema.ts`.

- [ ] **Step 1: Write the failing schema guard test.** In `schema-guard.test.ts`, iterate over every exported pgTable via Drizzle's `getTableConfig`. Assert each has a `world_id` column with notNull, except `worlds`, `principals` and `webhook_events` (nullable).
- [ ] **Step 2: Write the failing world-scoping test.** In `scoped.test.ts`: create two worlds, insert one agent in each via `scoped().insert`, and assert that `scoped(db, worldA).select(agents)` returns only world A's agent.
- [ ] **Step 3: Implement.** Write the schema, client, `scoped` and `testing` modules. Generate the migration with `npm run db:generate`. `createTestDb` applies it with `migrate` from `drizzle-orm/pglite/migrator`.
- [ ] **Step 4: Verify.** Run `npm test -- tests/unit/db`; expect PASS. Run `npm run typecheck`; expect 0 errors.
- [ ] **Step 5: Commit** as `feat(db): full schema with world isolation`.

### Task 3: Double-entry ledger

**Files:**
- Create: `src/server/ledger/accounts.ts`, `src/server/ledger/postJournal.ts`, `src/server/ledger/trialBalance.ts`, `src/server/ledger/errors.ts`, `tests/unit/ledger/postJournal.test.ts`, `tests/unit/ledger/property.test.ts`

**Chart of accounts:** each entry is `code → type`.
- `cash_paypal` → asset
- `loans_receivable` → asset
- `fees_receivable` → asset
- `allowance_for_losses` → contra_asset
- `notes_payable` → liability (owner_ref = agent id)
- `payable_to_borrower` → liability (owner_ref = agent id)
- `fee_income` → income
- `late_fee_income` → income
- `provision_expense` → expense
- `bank_equity` → equity
- `suspense` → asset

**Interfaces:**
- Consumes: `Db`, `scoped`, the `ledger_accounts`, `journal_entries` and `postings` tables (Task 2).
- Produces:
  - `ensureChartOfAccounts(db: Db, worldId: string): Promise<void>`: idempotent.
  - `postJournal(db: Db, input: { worldId: string; memo: string; sourceType: string; sourceId: string; simAt: Date; idempotencyKey: string; postings: { accountCode: AccountCode; ownerRef?: string; amountCents: bigint }[] }): Promise<{ entryId: string; replayed: boolean }>`.
    - Runs in one transaction.
    - Creates owner-ref sub-accounts on demand.
    - Sign convention: positive = debit, negative = credit.
  - `trialBalance(db: Db, worldId: string): Promise<{ accounts: {code, ownerRef, balanceCents: bigint}[]; totalCents: bigint }>`.
  - Errors: `UnbalancedJournalError`, `EmptyJournalError`, `ZeroAmountPostingError`.

- [ ] **Step 1: Write the failing unit tests.** In `postJournal.test.ts`:
  - a balanced 2-line entry (`cash_paypal +25000`, `notes_payable[agentA] -25000`) is stored, and `trialBalance().totalCents === 0n`;
  - `+100/-99` throws `UnbalancedJournalError` and writes 0 rows;
  - an empty postings list throws `EmptyJournalError`;
  - a `0n` line throws `ZeroAmountPostingError`;
  - posting the same `idempotencyKey` twice returns `replayed: true` with the same `entryId`, and the journal count is still 1.
- [ ] **Step 2: Write the failing property test.** In `property.test.ts`, using fast-check, generate 1–20 random balanced entries (2–5 lines each, amounts −1e9..1e9 excluding 0, adjusted so each sums to 0). After posting them all, the `totalCents` of `trialBalance` must be `0n` (numRuns 50).
- [ ] **Step 3: Run the tests.** Run `npm test -- tests/unit/ledger`; expect FAIL.
- [ ] **Step 4: Implement.** Validate in TS before any write, then insert the entry and postings in one `db.transaction`. On a unique-violation of `(world_id, idempotency_key)`, return the existing entry with `replayed: true`.
- [ ] **Step 5: Verify.** Run `npm test -- tests/unit/ledger`; expect PASS.
- [ ] **Step 6: Commit** as `feat(ledger): balanced double-entry journal with idempotency`.

### Task 4: Bank clock and worlds

**Files:**
- Create: `src/server/clock/clock.ts`, `src/server/services/worlds.ts`, `tests/unit/clock/clock.test.ts`

**Interfaces:**
- Consumes: `Db`, `worlds`, `clock` (Task 2), `ensureChartOfAccounts` (Task 3).
- Produces:
  - `simNow(state: {anchorReal: Date; anchorSim: Date; speed: number; manualOffsetMs: bigint}, realNow: Date): Date`.
    - Pure: `anchorSim + (realNow - anchorReal) * speed + manualOffsetMs`.
  - `getSimNow(db: Db, worldId: string, realNow?: Date): Promise<Date>`.
  - `advanceClock(db: Db, worldId: string, days: number): Promise<Date>`: adds `days * 86_400_000` to `manual_offset_ms`. Rejects `days <= 0` or `days > 365`.
  - `ensureMainWorld(db: Db): Promise<{ worldId: string }>`: slug `main`, rail_mode `paypal`, speed `0`, anchors = now. Seeds the chart of accounts and is idempotent.
  - `createWorld(db: Db, input: { name: string; ownerPrincipalId: string | null; railMode: 'paypal'|'sim'|'mixed' }): Promise<{ worldId: string; slug: string }>`.

- [ ] **Step 1: Write the failing tests.**
  - `simNow` with speed 0 returns `anchorSim + offset`.
  - With speed 1440 (1 real minute = 1 sim day), 60 s of real time advances 1 day.
  - `advanceClock(…, 7)` moves `getSimNow` forward by exactly 7 days.
  - `advanceClock(…, 0)` throws.
  - `ensureMainWorld` called twice returns the same id.
  - `createWorld` seeds the chart of accounts, so `trialBalance` lists 0 accounts with non-zero balances.
- [ ] **Step 2: Implement.** Run `npm test -- tests/unit/clock`; expect PASS.
- [ ] **Step 3: Commit** as `feat(clock): per-world simulated bank clock and worlds`.

### Task 5: PayPal client and payment rails

**Files:**
- Create:
  - `src/server/paypal/config.ts`
  - `src/server/paypal/token.ts`
  - `src/server/paypal/fetch.ts`
  - `src/server/paypal/orders.ts`
  - `src/server/paypal/payouts.ts`
  - `src/server/paypal/redact.ts`
  - `src/server/rail/types.ts`
  - `src/server/rail/paypalRail.ts`
  - `src/server/rail/simRail.ts`
  - `tests/unit/paypal/fetch.test.ts` (msw)
  - `tests/unit/rail/simRail.test.ts`
  - `tests/integration/paypal/sandbox.test.ts`

**Interfaces:**
- Consumes: `Db`, `paypal_operations` (Task 2).
- Produces:
  - **`paypalConfig()`:** returns `{ baseUrl, clientId, clientSecret }`. It reads `PAYPAL_BASE_URL` (default sandbox), `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`, and throws `PayPalConfigError` if missing.
  - **`getAccessToken(force?: boolean): Promise<string>`:** in-memory cache, refreshed 60 s before expiry.
  - **`paypalFetch<T>(db: Db, op: { worldId: string; kind: string; method: 'GET'|'POST'|'PATCH'; path: string; body?: unknown; operationId?: string }): Promise<{ status: number; body: T; operationId: string }>`:**
    1. Inserts a `paypal_operations` row first; its id becomes the `PayPal-Request-Id`.
    2. On 401, refreshes the token once and retries.
    3. On 5xx or network error, retries up to 2 times (backoff 300 ms, 900 ms) with the **same** request id.
    4. Stores the redacted request and response, `http_status`, `latency_ms` and `attempts`.
    5. Throws `PayPalApiError{status, name, details, debugId}` on a final non-2xx.
  - **`orders.create(db, {worldId, amountCents, description, customId, payeeEmail?, returnUrl, cancelUrl})`:** returns `{ orderId, approveUrl, status }`. Builds an `intent: CAPTURE` order in USD, with `purchase_units[0].payee.email_address` when `payeeEmail` is set.
  - **`orders.capture(db, {worldId, orderId})`:** returns `{ status, captureId, amountCents }`.
  - **`orders.get(db, {worldId, orderId})`.**
  - **`payouts.send(db, {worldId, receiver, receiverType: 'EMAIL'|'PAYPAL_ID', amountCents, note, senderItemId})`:** returns `{ batchId, itemId?, batchStatus }`. `sender_batch_id` is the operation id.
  - **`payouts.get(db, {worldId, batchId})`:** returns `{ batchStatus, items: {itemId, transactionStatus}[] }`.
  - **Rail interface** in `rail/types.ts`: `interface PaymentRail { name: 'paypal'|'sim'; createCheckout(...)…; captureCheckout(...)…; getCheckout(...)…; sendPayout(...)…; getPayout(...)… }`.
    - Its method signatures mirror `orders.*` and `payouts.*`.
    - Every result also carries `rail` and `operationId`.
  - **`paypalRail(db)` and `simRail(db)`:**
    - The sim rail writes `paypal_operations` rows with `rail='sim'`.
    - Its checkouts are auto-approvable via `simApprove(orderId)`.
    - Its payouts succeed instantly unless the receiver contains `fail`.
  - **`redact(obj)`:** masks keys matching `/token|secret|password|authorization/i`, and email local-parts to the first two characters.

- [ ] **Step 1: Write the failing msw unit tests** in `fetch.test.ts`:
  - a 401 then 200 sequence makes exactly 2 calls, both with the same `PayPal-Request-Id`, and fetches a new token;
  - 503, 503, 200 makes 3 calls with the same request id and `attempts=3`;
  - a final 422 throws `PayPalApiError` with `name` taken from the body;
  - the stored request JSON contains no `Authorization` header or secret.
- [ ] **Step 2: Write the failing sim rail tests** in `simRail.test.ts`: create → `simApprove` → capture returns COMPLETED; a payout to `ok@x` succeeds; a payout to `fail@x` returns FAILED.
- [ ] **Step 3: Write the sandbox integration test** (`describe.skipIf(!process.env.PAYPAL_CLIENT_ID)`):
  - get a token;
  - create a $1.00 order and assert `approveUrl` contains `sandbox.paypal.com`;
  - `orders.get` returns `CREATED`.
- [ ] **Step 4: Implement**, then run `npm test -- tests/unit/paypal tests/unit/rail`; expect PASS. If credentials are present, also run `npm test -- tests/integration/paypal`; expect PASS.
- [ ] **Step 5: Commit** as `feat(paypal): idempotent sandbox client and payment rails`.

### Task 6: Contract registry → REST + MCP + OpenAPI, first tool `get_bank_guide`

**Files:**
- Create:
  - `src/server/contracts/envelope.ts`
  - `src/server/contracts/registry.ts`
  - `src/server/contracts/tools/getBankGuide.ts`
  - `src/server/services/guide.ts`
  - `src/app/api/v1/[tool]/route.ts`
  - `src/app/api/mcp/[transport]/route.ts`
  - `src/app/openapi.json/route.ts`
  - `tests/unit/contracts/registry.test.ts`
  - `tests/unit/api/rest.test.ts`
  - `tests/e2e/mcp.spec.ts`

**Interfaces:**
- Consumes: `ensureMainWorld`, `getSimNow` (Task 4).
- Produces:
  - **`type Envelope<T>`** and **`ok(data, {status, summary, next_actions?, reason_codes?})`** and **`fail(status, summary, reason_codes)`** in `envelope.ts`. `docs_url` defaults to `${PUBLIC_BASE_URL}/agents.md`.
  - **`defineTool({ name, title, description, auth: 'none'|'agent', mutating: boolean, input: ZodObject, output: ZodType, handler: (input, ctx) => Promise<Envelope<unknown>> })`.**
  - **`registry: ToolDef[]`.** The order is the registration order.
  - **`ctx` type:** `{ worldId: string; simNow: Date; agentId: string | null; requestId: string }`.
  - **REST:**
    - `POST /api/v1/{tool}` with a JSON body.
    - `GET /api/v1/get_bank_guide` is also allowed.
    - Errors return the envelope: unknown tool → 404 `NOT_FOUND`; Zod failure → 400 `INVALID_REQUEST` with `reason_codes` = the issue paths.
  - **MCP:** `createMcpHandler` at `basePath: "/api/mcp"`, server name `mandate-bank`. One MCP tool per registry entry; `inputSchema` comes from the Zod shape. The result is `content[0].text = JSON.stringify(envelope)` plus `structuredContent = envelope`.
  - **OpenAPI:** `GET /openapi.json` returns an OpenAPI 3.1 document with one `POST /api/v1/{name}` path per tool. Request bodies come from `z.toJSONSchema(input)` and the response is the envelope schema.
  - **`get_bank_guide`** (no auth, no input) returns `status "OK"` and data:
    - `{ bank: "Mandate", what_it_is, how_to_start: string[], tools: {name, title, description}[], money_rules: { currency: "USD", loan_range_cents: [1000, 50000], term_days: [7, 30] }, disclaimer: "Mandate is a sandbox model. Notes are not deposits and are not FDIC-insured." }`
    - `next_actions: [{tool:"register_agent", args:{}}]`.
    - It may list tools that aren't implemented yet, but only from the registry.

- [ ] **Step 1: Write the failing tests.**
  - `registry.test.ts`: names are unique snake_case; every tool has a description of at least 40 characters; OpenAPI generation includes `/api/v1/get_bank_guide`.
  - `rest.test.ts`: call the route handler directly. `get_bank_guide` returns 200 with `status:"OK"` and `bank:"Mandate"`. `POST /api/v1/nope` → 404 `NOT_FOUND`. A tool given invalid JSON → 400 `INVALID_REQUEST`.
  - `mcp.spec.ts` (Playwright `request`): POST JSON-RPC `initialize`, then `tools/list`, to `/api/mcp/mcp`. The list includes `get_bank_guide`. Then `tools/call` `get_bank_guide` returns text containing `"bank":"Mandate"`.
- [ ] **Step 2: Implement.** Follow the mcp-handler 2.x README for the exact `createMcpHandler` signature and its `@modelcontextprotocol/server` peer. Run `npm test -- tests/unit/contracts tests/unit/api` and `npm run e2e -- mcp`; expect PASS.
- [ ] **Step 3: Commit** as `feat(api): contract registry with REST, MCP and OpenAPI; get_bank_guide`.

### Task 7: Deploy and day-1 PayPal spikes (needs secrets)

**Files:**
- Create:
  - `scripts/spikes/token-and-order.ts`
  - `scripts/spikes/payout.ts`
  - `scripts/spikes/payee-routing.ts`
  - `scripts/spikes/vault.ts`
  - `scripts/spikes/login-with-paypal.md` (manual or Playwright steps)
  - `scripts/spikes/openai-models.ts`
  - `docs/spikes.md`
  - `vercel.json` (crons placeholder, empty array)

**Interfaces:** consumes Task 5 (`paypalRail`, `orders`, `payouts`).

- [ ] **Step 1: Deploy.**
  - Copy every secret from `.env.local` to Vercel envs (Development, Preview, Production) with `vercel env add`.
  - Run `vercel deploy` (preview), then `vercel deploy --prod`.
  - Run `npm run db:migrate` against Neon `DATABASE_URL`.
  - **Expected:** `/api/v1/get_bank_guide` on the prod URL returns `status:"OK"`.
- [ ] **Step 2: Run each spike with `npx tsx scripts/spikes/<name>.ts` and record the result in `docs/spikes.md`.** For each one record: the command, the PayPal response status/ids, pass/fail, the fallback decision, and the time taken.
  - **Token + order:** an order is created.
  - **Payout:** $1.00 to `PAYPAL_OWNER_EMAIL`. Record the batch status over time (poll 10× at 3 s).
  - **Payee routing:** create an order with payee `PAYPAL_BANK_EMAIL`. Approve it in Playwright as `PAYPAL_CLIENT_EMAIL`, capture it, and confirm the capture's `payee`.
  - **Vault:** a setup token for the owner. Record the response, including any expected `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE`.
  - **Log in with PayPal:**
    1. Authorize URL at `https://www.sandbox.paypal.com/signin/authorize` with `scope=openid email https://uri.paypal.com/services/paypalattributes`.
    2. Log in as the owner in Playwright.
    3. Exchange the code and call userinfo.
    4. Record whether `payer_id` and `email` are returned. The return URL must be registered in the app first; ask Huzaifa to add it.
  - **OpenAI models:** `GET /v1/models`, then record which ids exist among `gpt-5.6-terra`, `gpt-5.6-luna` and `gpt-6-astra`, and the closest available.
- [ ] **Step 3: Create the PayPal webhook.**
  - Create it via `POST /v1/notifications/webhooks` at `https://<prod-domain>/api/webhooks/paypal` (endpoint stub returns 200).
  - Subscribe to: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.PAYOUTSBATCH.SUCCESS`, `PAYMENT.PAYOUTSBATCH.DENIED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `PAYMENT.PAYOUTS-ITEM.FAILED`, `PAYMENT.PAYOUTS-ITEM.UNCLAIMED`, `PAYMENT.PAYOUTS-ITEM.RETURNED`, `VAULT.PAYMENT-TOKEN.CREATED`.
  - Store `PAYPAL_WEBHOOK_ID` in Vercel envs and `.env.local`.
- [ ] **Step 4: Commit** as `chore: deploy, webhook registration, day-1 PayPal spikes`.

### Task 8: Design pack for approval

**Files:**
- Create:
  - `docs/design/index.html`, linking all of the following
  - `docs/design/owner-dashboard-v1.html`
  - `docs/design/owner-dashboard-v2.html`
  - `docs/design/console-v1.html`
  - `docs/design/console-v2.html`
  - `docs/design/system-diagrams.html`

**Content rules:**
- Static HTML with inline CSS only; no external requests. Use the Global Constraints tokens and the light theme.
- Use realistic demo data: agent "Nova", owner Studio LLC, a $250 loan for 14 days, fee $4.12, score 74, grade B.
- **Owner dashboard (agent cards + drawer):**
  - **v1:** the cards grid with a right-hand drawer.
  - **v2:** the cards grid with the drawer as a full-height page split. Show the PENDING_CLAIM card with a "Paste claim link" affordance and the mandate summary.
- **Console (mission control):**
  - **v1:** KPI strip, clock controls, flow diagram, then tabs below.
  - **v2:** KPI strip, with the flow diagram and the PayPal log side by side above the tabs.
  - The grids are static tables styled like AG Grid's Quartz theme.
- **System diagrams** (inline SVG):
  - architecture (agents → MCP/REST → services → ledger/DB → rail → PayPal);
  - the onboarding sequence (paths A and B);
  - the loan state machine;
  - the money flow for Nova's loan, with the PayPal API named on each edge.

- [ ] **Step 1:** Build the pages.
- [ ] **Step 2:** Open each one in Playwright at 1280 and 390 wide. **Expected:** no horizontal overflow at 1280, and none outside the scrollable diagram containers at 390.
- [ ] **Step 3:** Commit as `docs(design): P0 design pack for approval`.
- [ ] **Step 4:** Huzaifa picks the variants. Record the choice in `docs/design/DECISIONS.md`.
