# P3 Scoring & Underwriting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Every loan application gets a deterministic credit decision, and every decision is explained:
  - an Agent Credit Score from 0 to 100, which sets a grade from A to E and a limit;
  - risk-based pricing;
  - a rules pipeline with Reg B–style reason codes.
- OpenAI writes the explanations, the KYA document reviews and the loan memos. Decisions never depend on the LLM: with the LLM off, the decision is identical.

**Architecture:**
- The credit domain is pure code: `src/server/domain/{scorecard,pricingV2,rules}.ts`.
- `src/server/ai/*` wraps the OpenAI Responses API with structured outputs (JSON schema), records every call in `ai_runs`, and falls back to a template on error, timeout or a disabled key.
- The loans service calls the pure pipeline under the series lock (P1/P2 order). After commit, a `finalize` step asks the AI layer for the narrative and stores it on the application.

**Tech Stack:** P2 stack plus the `openai` npm SDK (Responses API, `text.format: json_schema`, strict). Model ids come from env: `OPENAI_MODEL_UNDERWRITER` (spike: gpt-6-astra) and `OPENAI_MODEL_CHECK` (gpt-5.4-nano).

**Spec:** `docs/superpowers/specs/2026-11-05-mandate-design.md` (P3 row; credit score 0–100 PAYDEX-style, grades A–E; "Decisions are deterministic code; the LLM writes explanations, document reviews and memos only, with template fallbacks"). Research: `docs/research/agentic-bank-research.md` (underwriting, Reg B adverse action, CA/NY disclosure). Rulings: P1 `docs/superpowers/plans/p1-rulings.md`; P2 `.superpowers/sdd/2026-11-06-p2-identity-mandates/progress.md`.

## Global Constraints
- **All P1/P2 rules still apply:**
  - integer cents and bps;
  - `scoped()`;
  - no PayPal call and no OpenAI call inside a DB transaction;
  - envelope and idempotency;
  - lock order: series → loan → positions;
  - tiers and mandates;
  - commit trailer `Co-Authored-By` only.
- **Score (0–100), computed from DB facts only.** It is the sum of these components, each clamped:

  | Component | Points |
  |---|---|
  | Identity | 0–25: claimed 10, T2 key 8, approved KYA doc 7 |
  | Repayment history | 0–35: on-time repaid loans ×7 (cap 35); minus 15 per late repayment; minus 35 if ever charged off. Late and charge-off arrive in P4; count them if columns exist, else 0 |
  | Tenure | 0–10: sim days since registration ÷ 3, capped |
  | Collateral | 0–20: an invoice-backed application with coverage ≥ 1.5 scores 20; ≥ 1.1 scores 12; none scores 0 |
  | Exposure | 0–10: 10 − 10 × principal exposure ÷ mandate `max_total_owed` (floor 0) |

  New agents start around 10–30. The score is recorded in `credit_scores` / `score_history` on each application with its component breakdown.
- **Grade and limit:**
  - Grades: A ≥ 80, B ≥ 65, C ≥ 50, D ≥ 35, E < 35.
  - Grade limit in cents: A 50000, B 30000, C 20000, D 10000, E 0 (decline).
  - Effective per-loan cap = min(grade limit, tier cap, mandate `max_per_loan`).
- **Pricing v2.** All fee components are in bps of principal for the term:
  - cost of funds = base 400 bps APR × term ÷ 365 (P5 makes the base dynamic);
  - expected loss = PD × LGD, where PD by grade is A 1%, B 3%, C 6%, D 12% and LGD is 60% unsecured or 35% invoice-covered ≥ 1.1;
  - ops = 50 bps flat;
  - capital = 8% × PD;
  - fee = ceil(principal × Σ ÷ 10000), with a minimum of 25 cents;
  - the mandate's `max_fee_bps` caps the fee: if the fee goes over it, decline `mandate_fee`;
  - APR bps = round(fee ÷ P × 365 ÷ term × 10000);
  - the disclosure flags APR > 3600 (CA/NY-style).
  - Golden cases are pinned in Task 2 tests.
- **Rules pipeline.** The order is fixed and the first hard failure wins. All reasons are collected for the notice:
  1. tier / claim;
  2. mandate;
  3. sanctions stub: name or operator matches the `SANCTIONS_STUB` list → `sanctions_hit`;
  4. grade E → `insufficient_credit_history` or `score_too_low`;
  5. amount > effective cap → `amount_exceeds_limit`;
  6. invoice coverage < 1.1 when an invoice is given → `insufficient_collateral`;
  7. declarations: the application's purpose must be non-empty, and the borrower attests "no other outstanding debts" via a boolean `declarations.no_other_debt`, which must be true, else `declaration_missing`;
  8. liquidity.
- **Reason codes** map to Reg B–style principal reasons. At most 4 are shown, using fixed human text in `src/server/domain/reasons.ts`.
- **Approval authority:**
  - auto-approve when grade ∈ {A, B, C} and P ≤ grade limit;
  - grade D → auto-approve only if P ≤ 5000, else `manual_review`;
  - `manual_review` in P3 is resolved by the risk agent, the LLM "risk officer" role. It can only *recommend*; the deterministic fallback for `manual_review` is decline with `manual_review_declined`. Ruling: P3 keeps the decision deterministic (D > 5000 → decline) and records the risk agent's opinion only.
- **AI roles.** Each has a JSON schema, a system prompt in `src/server/ai/prompts/*.md` and a template fallback:
  - **KYA desk** reviews uploaded docs and returns `{verdict: approve | needs_info | reject, findings[]}`. It is advisory: the auto-review from P2 stays authoritative, and the verdict shows in the dashboard.
  - **Loan officer** explains the decision and returns `{summary, reasons_explained[], next_steps[]}`. It uses the same reasons and never adds new ones; a validator rejects outputs that mention reasons not in the input.
  - **Risk officer** writes a memo for D grades / manual review: `{memo, concerns[]}`.
  - Every call is logged in `ai_runs`: role, model, input hash, output, latency, tokens, fallback_used, error code. The 20 s timeout falls back to the template, and `OPENAI_DISABLED=1` forces templates.
  - Inputs are redacted: no emails and no payout ids.
- **Disclosure v2 and adverse action:**
  - The offer disclosure adds: grade, score, rate components, APR flag text, total cost, and "Right to a statement of specific reasons".
  - A DECLINED application returns `adverse_action: { reasons: [{code, text}], score, score_factors[], notice: "<fixed template>", explanation: <loan officer text or template> }`. A copy is stored on the application and shown in the dashboard.
- **ALA (application) sections A–H:**
  - A identity
  - B purpose
  - C amount & term
  - D collateral (invoice)
  - E declarations
  - F consent to credit check of bank records
  - G mandate reference
  - H attestation (agent attests the info is accurate; `attest: true` required)

  `apply_for_loan`'s input grows (backwards compatible): new fields are optional except `declarations.no_other_debt` and `attest`. They default to false, which gives `declaration_missing`, so docs and the harness must send them.

## Review Focus
1. **The LLM changes a decision or invents reasons.** Run with `OPENAI_DISABLED=1` and with mocked LLM outputs, including malicious ones that add reasons or claim approval. Status, reasons, price and limit must be byte-identical. *Test in Task 4.*
2. **OpenAI slow, erroring or returning invalid JSON.** Apply still responds within the normal time, because AI runs after commit in `finalize` and is time-bounded. The template is used and the `ai_runs` row has `fallback_used=true`. *Test in Task 3.*
3. **Score gaming.** Many tiny invoice-backed loans would inflate history; the "on-time repaid ×7" is capped at 35, and only loans ≥ 1000 cents count. Self-dealing, where an agent pays its own invoice link, counts as on-time. Accepted for P3, documented. *Test in Task 1.*
4. **Pricing edge cases:** P = 1000, term 7, grade A with an invoice gives the minimum fee of 25. P = 50000, term 30, grade D gives a fee over the mandate cap and a decline. Results must be deterministic and integer. *Test in Task 2.*
5. **PII leakage to OpenAI:** payloads sent to OpenAI must not contain emails, payer ids or API keys. Assert on captured request bodies. *Test in Task 3.*

---

### Task 1: Scorecard, grades and limits (pure + persistence)
- **Files:** `src/server/domain/scorecard.ts`, `src/server/services/credit.ts` (`scoreAgent(db, worldId, agentId, simNow, application?) → {score, grade, components, limitCents}`; persists to `credit_scores` / `score_history`); migration if columns are missing; tests with golden component vectors.
- **Wiring:** `get_status` and `check_eligibility` show score, grade and limit plus the top 3 score factors. The dashboard card ring shows the score (replacing the tier ring from P2).

### Task 2: Pricing v2 and rules pipeline
- **Files:** `src/server/domain/pricingV2.ts`, `src/server/domain/rules.ts`, `src/server/domain/reasons.ts`, tests with goldens:
  - (10000, 14, B, unsecured)
  - (10000, 14, B, invoice 1.5)
  - (1000, 7, A, invoice)
  - (50000, 30, D, none)
  - grade E → decline
- **Wiring:** the loans service `createLoanOffer` uses the pipeline, replacing P1 pricing. The P1 `price()` stays only where golden tests need it, or remove it and update the P1 goldens with a note. Disclosure v2 fields are hashed.

### Task 3: AI layer (OpenAI Responses + structured outputs + audit + fallbacks)
- **Files:** `src/server/ai/{client,run,schemas,templates,redact}.ts`, `src/server/ai/prompts/{kya_desk,loan_officer,risk_officer}.md`, msw-mocked tests (timeout, 500, invalid JSON, schema-violating output, disabled).
- **Interface:** `runRole(db, worldId, role, input) → {output, fallbackUsed, aiRunId}`. It is never called inside a transaction. A grep guard test enforces this, like the PayPal guard.
- **Spike:** one real call per role with `npx tsx --env-file=.env.local scripts/spikes/ai-roles.ts`. Record latency and cost in `docs/spikes.md`. Never print the key.

### Task 4: Underwriting integration, adverse action and ALA A–H
- **apply_for_loan:** new input sections, the pipeline under the lock, and the adverse-action payload.
- **finalize:** calls the loan officer (and the risk officer for grade D) and stores the narrative on the application. Envelope fields `explanation` and `memo` fall back to templates.
- **Agent re-fetch:** `get_loan` / a new `get_application` tool (readOnly) re-fetches the explanation.
- **KYA desk:** runs after a document upload (dashboard route, after the response, via `after()`). Its verdict is shown in the drawer.
- **Tests:** Review Focus 1 (decision byte-identical with the LLM disabled vs mocked malicious LLM), plus adverse action for each reason.

### Task 5: Docs, harness, deploy, acceptance
- **agents.md:** scoring, grades, pricing components, reason codes, ALA fields (with an example application), and adverse action.
- **Harness:** sends ALA fields. Add a scripted decline run: the borrower asks for 50000 at T1 with no history, and the agent must explain the decline to its human using the adverse-action text. Pass means the agent's final message mentions at least one reason code's text.
- **Deploy:** run migrations (or ask the user if the classifier blocks), deploy prod from a clean worktree, then 3/3 local agent runs and prod runs as available.
- **Tag** `p3-underwriting`.
