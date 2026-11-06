# P2 Identity, Mandates & Owner Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A human (the borrower of record) proves who they are with PayPal and claims their agents. They upload know-your-agent documents and sign a standing mandate that caps what their agents may borrow. They watch everything in an owner dashboard. Testers get private sandbox worlds with seeded bots and a controllable clock.

**Architecture:** This builds on P1.
- **Identity:** "Verify with PayPal" is a $0.01 Orders checkout that is approved but **never captured**. Approval reveals the payer's `payer_id` and email via `order.get`. This is the P0 spike fallback, used because Log in with PayPal is unavailable.
- **Sessions:** principals get a signed, HttpOnly session cookie.
- **Onboarding** has two paths:
  - **A:** the agent self-registers, gets a claim URL, and the human claims it.
  - **B:** the human creates the agent in the dashboard and gets an MCP config with a key.
- **Mandates:** versioned rows. They are enforced in check_eligibility, apply_for_loan and accept_offer, with exposure rolled up across all of a principal's agents.
- **Private worlds:** run on the sim rail. Bots act during the tick cron.

**Tech Stack:** P1 stack. There are no new services. KYA documents are stored in Postgres as `bytea`, capped at 2 MB each (Ruling P2-A: no Blob store dependency). Ed25519 verification uses `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-11-05-mandate-design.md` (P2 row, decisions table, state machines). Design: `docs/design/owner-dashboard-v1.html` (chosen) and `docs/design/system-diagrams.html` (onboarding paths A/B). P1 rulings: `.superpowers/sdd/2026-11-06-p1-core-loop/progress.md` (archived copy in `docs/superpowers/plans/p1-rulings.md`).

## Global Constraints
- All P1 Global Constraints and rulings still apply:
  - integer cents;
  - `world_id` everywhere, via `scoped()`;
  - no PayPal call inside a transaction;
  - the envelope;
  - idempotency;
  - lock order series → loan → positions;
  - Ruling J/R payout semantics;
  - the commit trailer is `Co-Authored-By` only.
- **Agent lifecycle (DB lowercase):** `pending_claim → active` (claimed) and `active ⇄ restricted → frozen`; `revoked`. `ALLOW_INSTANT_ACTIVATION` is removed from the decision path. Every self-registered agent is `active` at **tier 0**.
- **KYA tiers** decide what an agent may do:

  | Tier | Requirement | May lend | May borrow |
  |---|---|---|---|
  | **T0** | unclaimed | yes (buy/redeem notes) | no; `apply_for_loan` → `CLAIM_REQUIRED` with the claim URL |
  | **T1** | claimed by a verified principal and a signed mandate | yes | within mandate limits, per loan ≤ 25000 cents |
  | **T2** | T1 + ≥1 approved KYA document + a registered Ed25519 key, with signed mutating requests | yes | within mandate limits, per loan ≤ 50000 cents |

  The tier is computed. It is never stored as a source of truth.
- **Claim:**
  - `register_agent` returns `claim_url = ${PUBLIC_BASE_URL}/claim/<token>`.
  - The token is 32 random bytes in base64url, stored as a sha256 hash, single-use, and expires after 7 real days.
  - `get_status` keeps showing the claim URL until the agent is claimed.
- **Session:**
  - Cookie `mandate_session` holds an HMAC-SHA256 signed `{principalId, exp}` using `SESSION_SECRET`.
  - It lasts 7 days and is set HttpOnly, Secure (prod), SameSite=Lax.
  - Logout clears it.
- **Verify with PayPal:**
  - Order amount is 0.01 USD, description "Mandate identity check (not charged)", with return URL `/verify/return`.
  - On return, `order.get` must show `status=APPROVED` and `payer.payer_id`.
  - The principal is upserted by `payer_id`; the order is never captured.
  - Purpose `identity_verification` is added to OperationPurpose.
- **Mandate fields:** max_per_loan_cents, max_total_owed_cents, max_fee_bps, max_term_days, eligible_collateral (`invoice_link`, `none`), and expires_at (optional).
  - Each version is immutable. Signing creates version n+1 and supersedes the previous one.
  - "Sign" means a checkbox plus typed full name, with stored timestamp, IP hash and the sha256 of canonical mandate JSON.
  - Revoking makes the agent unable to borrow; existing loans are unaffected.
- **Mandate enforcement:** an offer is declined with reason codes `mandate_missing | mandate_per_loan | mandate_total_owed | mandate_fee | mandate_term | mandate_collateral` when it breaks the mandate.
  - Total owed = Σ outstanding of the principal's agents' open loans + this principal amount + fee.
  - The check runs again at accept, under the series lock.
- **Ed25519 signing:**
  - Headers are `X-Mandate-Timestamp` (unix seconds, ±300 s) and `X-Mandate-Signature` (base64 signature over `${timestamp}\n${METHOD}\n${path}\n${sha256hex(body)}`).
  - The key is registered via the `register_public_key` tool (SPKI base64 or raw 32-byte base64).
  - Once registered, unsigned mutating calls from that agent → 401 `SIGNATURE_REQUIRED`.
  - Over MCP, the signature covers the JSON-RPC body.
- **Private worlds:**
  - A verified principal may create up to 3. Rail is `sim`, with clock controls +1d/+7d.
  - Each is seeded with 2 lender bots and 2 borrower bots, funds labelled "simulated".
  - Agents created in a private world (path B) get keys bound to it.
- **UI:** the light theme only, with the design tokens in `src/app/globals.css`. Layout is modern fintech: white background, deep-blue accent, green for money in, red for risk. Cards + drawer as in owner-dashboard-v1. It must work at 390 px width.
- **Copy:** every money surface carries "Sandbox model · simulated money · notes are not deposits and not FDIC-insured".

## Review Focus
1. **A stolen or replayed claim token, or one agent claimed twice.** A token can be used once. A claimed agent can't be claimed by another principal. An expired token → a clear page. *Test in Task 2.*
2. **Mandate total-owed race.** Two agents of one principal accept concurrently and together would exceed `max_total_owed`. Exactly one succeeds; the check runs under the series lock. *Test in Task 4 (PGlite and test:pg).*
3. **Session forgery, or dashboard actions on another principal's agent.** Every owner route checks ownership. An attacker who changes an id in the URL or form gets 404. *Test in Task 5.*
4. **Ed25519 replay:** the same signed request resent after 300 s, or with a modified body → 401. A signature replayed within the window on a mutating call is caught by idempotency or by a nonce, and can't double-execute. *Test in Task 3.*
5. **Bots or private-world actions leaking into the main world.** Bots and private worlds never use the PayPal rail, and never appear in main-world queries or the console. *Test in Task 6.*

---

### Task 1: Principals, sessions and Verify with PayPal
**Files:**
- Create: `src/server/auth/session.ts`, `src/server/services/principals.ts`, `src/app/verify/start/route.ts` (POST → creates the order and redirects to approve), `src/app/verify/return/page.tsx`, `src/app/logout/route.ts`, tests.
- Modify: `src/server/paypal/operationId.ts` (purpose), schema (principals: payer_id unique, email, name, verified_at; sessions are stateless), `.env.example` (`SESSION_SECRET`).

**Interfaces:**
- `createSession(principalId) → cookie value`; `readSession(cookieValue) → {principalId} | null` (constant-time HMAC compare, expiry check).
- `startVerification(db, {returnTo}) → approveUrl`. The world is main; the op is enqueued and executed outside a transaction.
- `completeVerification(db, orderId) → principal`. It is idempotent: the same order → the same principal. A non-APPROVED order → an error page.
- Route guard `requirePrincipal(request)` for owner pages and actions.
- Tests:
  - a sim-rail verification sets a session that `readSession` reads back;
  - a tampered cookie → null;
  - an expired cookie → null;
  - completing the same order twice → one principal;
  - the order is never captured (no `order.capture` op).

### Task 2: Claim flow (path A) and KYA tiers
**Files:**
- Create: `src/server/services/claims.ts`, `src/server/domain/kya.ts` (`computeTier(agent, principal, mandate, docs, key)`), `src/app/claim/[token]/page.tsx`, tests.
- Modify: `register_agent` (always issues a claim token; returns `claim_url`), `get_status` (tier, claim_url while unclaimed, next steps), `apply_for_loan` / `check_eligibility` (tier gate → `CLAIM_REQUIRED` 403 with `claim_url` in data), schema (agents.principal_id, claim_token_hash, claim_expires_at, claimed_at).

**Interfaces:**
- Claim page:
  - Not logged in → a "Verify with PayPal to claim <agent name>" button. Verification returns to the claim page.
  - Logged in → a "Claim" button → `claimAgent(db, principalId, token)`.
  - `claimAgent` locks the agent row: unclaimed + valid + unexpired → set principal, then null the token.
- Tests (Review Focus 1):
  - single use;
  - expired;
  - already claimed by another principal → 409 page;
  - T0 cannot borrow;
  - T1 needs a mandate (Task 4 provides it; here assert `mandate_missing`).

### Task 3: KYA documents and Ed25519 keys
**Files:**
- Create: `src/server/services/kyaDocs.ts`, `src/server/auth/signatures.ts`, the tool `register_public_key`, the owner upload route `src/app/dashboard/agents/[id]/documents/route.ts` (multipart; pdf/png/jpg; ≤ 2 MB), tests.
- Modify: `runTool` (signature verification step for agents with a key; mutating calls only; replay protection via a `(agent_id, signature)` unique table with 10-minute retention, or by requiring an `Idempotency-Key` on signed calls — choose the nonce table), MCP route (forward the signature headers), schema (agent_keys, kya_documents.content bytea + review_status).

**Interfaces:**
- KYA review in P2 is automatic: a basic check (type and size) gives `approved`. P3 adds the LLM review.
- Tests (Review Focus 4):
  - a valid signature passes;
  - a wrong body → 401;
  - a timestamp skewed by 301 s → 401;
  - a replayed signature → 401 `SIGNATURE_REPLAYED`;
  - an unsigned call after key registration → 401 `SIGNATURE_REQUIRED`;
  - tier becomes T2 once a document is approved and a key is registered.

### Task 4: Mandates and principal exposure
**Files:**
- Create: `src/server/domain/mandate.ts` (pure `checkMandate(mandate, exposure, offer) → reasons[]`), `src/server/services/mandates.ts` (sign, revoke, current), tests.
- Modify: loans service (eligibility, apply, accept use `checkMandate`, and principal exposure under the series lock), disclosure (`mandate_id` + version included and hashed), schema (mandates table columns per Global Constraints).

**Interfaces:**
- The exposure query sums the outstanding of open loans for all agents with the same `principal_id` in the world.
- Tests:
  - every reason code;
  - the concurrent total-owed race on test:pg (Review Focus 2);
  - accept re-check after a mandate is revoked → `MANDATE_REVOKED`.

### Task 5: Owner dashboard v1 (cards + drawer) and path B
**Files:**
- Create: `src/app/dashboard/**` (layout with the session guard; agent cards grid; detail drawer with Loans / Notes / Events tabs; mandate editor and sign form; documents upload; keys panel to rotate or revoke the API key and show the public key; "Register an agent" for path B, which shows the key and MCP config snippets once; "Paste claim link"; summary strip with owed across agents, mandate ceiling and agents active), `src/server/services/dashboard.ts` (read models), Playwright e2e for the main owner journey at 1280 and 390 px.

**Interfaces:**
- All mutations are server actions or route handlers that check ownership. Another principal's agent id → 404 (Review Focus 3).
- Freezing an agent stops it from calling mutating tools (status `frozen` → `AGENT_NOT_ACTIVE`).

### Task 6: Private worlds, bots, clock controls
**Files:**
- Create: `src/server/services/privateWorlds.ts`, `src/server/bots/{lenderBot,borrowerBot}.ts`, the dashboard "Sandbox worlds" page (create world; +1d/+7d; reset), tests.
- Modify: tick cron (run bot steps for private worlds; deterministic seeded RNG per world), `register_agent` via dashboard path B with a world choice.

**Interfaces:**
- Bots act through the same services as agents: they buy notes, apply, accept, and repay via sim approve + `settleCheckoutByOrderId`. They never touch PayPal.
- Tests (Review Focus 5):
  - no PayPal op with `rail='paypal'` is ever created in a private world;
  - main-world reads exclude private worlds;
  - trial balance is 0 after 30 simulated days of bot activity.

### Task 7: Agent docs, harness, deploy, acceptance
- Update `agents.md` (tiers, claim flow, mandates, signing, private worlds).
- Update the acceptance harness: the borrower run includes the human claim step (Playwright verifies as OWNER and claims) and mandate signing (dashboard form) before borrowing.
- Deploy: migrations (user-run if the classifier blocks), `SESSION_SECRET` in Vercel, then prod 3/3 agent runs.
- Tag `p2-identity`.
