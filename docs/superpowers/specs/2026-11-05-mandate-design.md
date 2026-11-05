# Plan: Build "Mandate — the bank for AI agents" (hardened agentic bank on PayPal sandbox)

## Context
Huzaifa's team is building the **hardened** agentic bank from the research explainer (`_bmad-output/planning-artifacts/research/domain-agentic-microloan-bank-2026-11-03/agentic-bank-explainer.html` + `research.md`) for the PayPal AI Hackathon. **Submission is due Nov 12, 2026, 12:00 PT, and today is Nov 5.**

The system has two halves:
- **Agents** (Claude, Codex, Cursor, any) must be able to register, understand the bank, fund it, borrow and repay with no UI.
- **Humans** register and vouch for their agents, upload documents and sign a standing mandate through a dashboard.

Judges must be able to plug in their own agents. PayPal sandbox money movement is central and must be robust. We build in rollback-able phases, test each one (including real Claude agents using the bank), and pause for approval at two milestones.

## Decisions (all confirmed by Huzaifa)
| Area | Decision |
|---|---|
| Name / repo | **Mandate**, at private repo `github.com/huzaifakhan04/agentic-bank`. `gh` and Vercel are already signed in as huzaifakhan04 |
| Funding side | **Lender-agent notes.** Agents with surplus cash buy borrower-payment-dependent notes, labelled "not a deposit · not FDIC-insured", and earn only from repayments |
| Borrower of record | The human owner or their business, through a **standing mandate** signed in advance (max per loan, max total owed, eligible collateral, max fee, max term). Loans of $10–$500 for 7–30 days |
| Agent access | One service layer exposed as a **REST API** (OpenAPI is the source of truth), a **remote MCP server** (Streamable HTTP) and **/llms.txt + /agents.md**. Agent-agnostic |
| Tool shape | About 12 task-level tools. Every response is `{status, summary, reason_codes, data, next_actions[{tool,args}], docs_url}` |
| Agent auth | API key (Bearer, shown once, hashed at rest) plus an optional Ed25519 key. Signed requests raise the KYA tier and limits |
| Onboarding | **Both paths.** (A) The agent self-registers, gets a claim URL, and its human claims it. (B) The human registers the agent in the dashboard and gets an MCP URL + key |
| Human login | **Log in with PayPal** (sandbox OIDC). It verifies the principal and links the payout account. Testers bring their own sandbox account |
| Repayment | (1) An invoice payment link: Orders v2 with `payee` = bank; the bank keeps loan + fee and pays out the remainder. (2) A direct checkout by the agent or owner. (3) Vault auto-debit attempted, falling back to (1)/(2) if sandbox refuses |
| Consequences | Score up/down (also rolled up to the principal), late fee + rate penalty, time-compressed ladder (Substandard → freeze → charge-off → guarantee invoked), limit growth on good behaviour |
| Economy harness | Utilization-based dynamic rates + per-grade premium; simulated base rate + inflation with real returns; treasury/ROI policy with CECL-style reserve and concentration limits; stress scenarios |
| Time | Simulated bank clock per world (+1d / +7d). **Private worlds** per tester, plus a shared "main" world |
| Bots | Seeded lender/borrower bots in private worlds use **SimRail** (labelled "simulated"). All human and agent actions use real PayPal sandbox |
| Stack | Next.js (App Router) + TypeScript monolith on Vercel, **npm**, Neon Postgres (Vercel Marketplace) + Drizzle, Vercel Blob for documents, **Vercel Pro cron** (every minute) |
| Bank's AI | **OpenAI** (Huzaifa's key) via the Responses API with structured outputs. Models are set by env (`OPENAI_MODEL_UNDERWRITER`, `OPENAI_MODEL_CHECK`; candidates GPT-5.6 Terra / Luna, confirmed via `/v1/models` on day 1). Decisions are deterministic code; the LLM writes explanations, document reviews and memos only, with template fallbacks |
| Credit score | Agent Credit Score 0–100 (PAYDEX-style), grades A–E |
| UX | Owner dashboard: **agent cards + detail drawer**. Public console: **mission control** (KPI strip, bank clock, animated flow, AG Grid tabs, live PayPal log). **Modern fintech look, light theme only** (white, deep-blue accent, green for money in, red for risk) |
| Sponsors | AG Grid (console tables), Postman (Run-in-Postman collection), APIMatic (SDKs/docs from OpenAPI + PayPal context plugin), Kernel (headless PayPal approvals for agents and tests). Optional late: Zapier (owner notices), Bryntum (repayment calendar), Elastic (event search / AML flags) |
| Agent tests | **Headless Claude Code** (`claude -p --mcp-config <bank>`) runs that know only the MCP URL; each phase needs 3/3 passing runs |
| Gates | Pause for approval after **P1** (core loop) and after **P5** (economy). Other phases run continuously with automated gates |

## Architecture
```
src/app/(public)  landing · /console (mission control) · /claim/[token]
src/app/(owner)/dashboard     agent cards + drawer (PayPal session)
src/app/api/v1/*              REST (thin: auth → zod parse → service → envelope)
src/app/api/mcp/[transport]   MCP server (same services)
src/app/api/webhooks/paypal   verify → store → outbox
src/app/api/cron/{tick,outbox,reconcile}
src/app/{llms.txt,agents.md,openapi.json}   generated from the contract registry
src/server/contracts  zod schemas per tool → REST + MCP inputSchema + OpenAPI (cannot drift)
src/server/services   one per tool/area (agents, eligibility, applications, offers, loans, repayments, notes, mandates, kya, worlds, statements)
src/server/domain     pure logic: state machines, pricing, scorecard, ladder, waterfall, economy
src/server/ledger     postJournal() double-entry (Σ postings = 0), chart of accounts, trial balance
src/server/rail       PaymentRail interface → PayPalSandboxRail | SimRail
src/server/paypal     OAuth token cache, fetch (PayPal-Request-Id = op id), orders, payouts, vault, identity, webhooks
src/server/ai         OpenAI client, structured prompts, ai_runs audit, fallbacks
src/server/{auth,clock,jobs,db}
```

**Flow of every mutating request:**
1. Authenticate the agent → `world_id`.
2. Take the idempotency key.
3. In one DB transaction: change domain rows, post the journal, append outbox events.
4. After commit, run the PayPal operation (a queued `paypal_operations` row, retried by cron).
5. Confirm through the verified webhook **and** reconcile polling (never trust webhooks alone).

**Data:**
- Every row carries `world_id`.
- Money is integer cents; rates are basis points.
- **Tables:** worlds, clock, principals, agents, api_keys, kya_documents, mandates, applications (ALA sections A–H), offers (disclosure + hash), loans, repayment_links, repayments, note_series / note_positions / note_transactions, ledger_accounts / journal_entries / postings, paypal_operations, webhook_events, events (outbox / feed), idempotency_keys, job_runs, credit_scores / score_history, economy_state, ai_runs.

**State machines** (pure functions with per-edge tests):
- **Agent:** PENDING_CLAIM → PENDING_KYA → ACTIVE ⇄ RESTRICTED → FROZEN; REVOKED; EXPIRED.
- **Loan:** SUBMITTED → UNDERWRITING → OFFERED | DECLINED (adverse action); then ACCEPTED → DISBURSING → ACTIVE → REPAID, or LATE → SUBSTANDARD → CHARGED_OFF → RECOVERED. A cure returns it to REPAID.
- **PayPal sub-states** map from payout item, order and capture statuses and webhooks.
- **Repayment waterfall:** late fees → fee → principal → remainder paid out to the borrower. Note holders are paid pro rata from fee income, net of spread and allowance.

**Agent tools:** get_bank_guide, register_agent, get_status, check_eligibility, apply_for_loan, accept_offer (must echo `disclosure_hash`), decline_offer, repay_loan, get_loan, buy_notes, redeem_notes, get_statement. Owner-only actions (claim, mandate, KYA uploads) are available in the dashboard and REST, not MCP.

## Phases (each ends with CI green, a deployed preview/prod, and git tag `pN-*` for rollback)
Execution method:
- Per phase, I write a detailed task plan in the repo (`docs/superpowers/plans/`, via superpowers:writing-plans).
- I execute it with **superpowers:subagent-driven-development**: a fresh implementer per task, a task review, the ledger in `.superpowers/sdd/`, and a final branch review.
- Work happens on a branch per phase, merged to `main` and tagged.

| Phase | Goal | Key tasks | Exit criteria |
|---|---|---|---|
| **P0 Foundation** (Nov 5–6) | Skeleton + money plumbing | Create private repo; Next.js/TS strict, Tailwind + shadcn light tokens, Vitest, Playwright, GitHub Actions CI; Neon + Drizzle with the **full schema** + world guard; ledger core (property tests); clock + worlds; PayPal client + rail interface + SimRail; contract registry → REST + MCP + OpenAPI with `get_bank_guide`; **day-1 spikes** (Payouts, Orders payee, webhooks, Vault, Log in with PayPal, `/v1/models`) written up in `docs/spikes.md`; **design pack**: HTML mockups of the chosen dashboard and console (two variants each) + system diagrams for approval | Deploys work; spikes pass or have documented fallbacks; ledger tests pass; design pack approved |
| **P1 Core loop** (Nov 6–7) ⏸ | Agents fund, borrow, repay | API keys + auth; idempotency; `buy_notes` / `redeem_notes` (Orders → capture; Payouts); `check_eligibility`, `apply_for_loan` (minimal ALA), auto-offer with fixed fee + disclosure, accept/decline, Payouts disbursement, `get_loan`; repayment via invoice link and direct checkout + waterfall + remainder payout; `repay_loan`, `get_statement`; webhooks + outbox + reconcile cron; minimal llms.txt / agents.md; acceptance harness (headless Claude Code + Kernel/Playwright approval helper) | Sandbox e2e: buy notes → loan → payout SUCCEEDED → client pays link → remainder paid → note distribution; trial balance 0; **3/3 agent runs**. **Pause for approval** |
| **P2 KYA + mandates + owner UX** (Nov 7–8) | Real identity and consent | Log in with PayPal + sessions; claim flow (path A) and dashboard registration (path B); KYA uploads (Blob) + tiers + Ed25519 signatures; mandate signing, versioning and enforcement + principal exposure roll-up; owner dashboard (cards + drawer); private worlds + seeded bots | Playwright login with sandbox account; mandate-limit matrix; cross-world isolation; 3/3 agent runs including the claim step |
| **P3 Scoring + underwriting** (Nov 8–9) | Credit scoring + loan approval | Scorecard → grade → limit (+ principal roll-up); pricing engine (cost of funds + PD×LGD + ops + capital, capped by mandate; APR; >36% flag); rules pipeline (mandate, sanctions stub, coverage ≥1.1×, declarations) + Reg B reason codes + approval authority; OpenAI roles (KYA desk, loan officer, risk) with structured outputs + audit + fallbacks; CA/NY-style disclosure v2 + adverse-action notices; full ALA sections A–H | Golden scorecard/pricing tests; decision identical with the LLM off; 3/3 runs including a scripted decline the agent explains |
| **P4 Clock + collections** (Nov 9) | Consequences over time | Ladder in `processDue` (due+1/+3/+7/+10), late fee + penalty, notices; score deltas + limit growth; charge-off with allowance, guarantee link to principal, recovery; Vault attempt + fallback; clock controls per world | Late → cure and charge-off → recovery paths, ledger balanced; vault fallback verified in sandbox |
| **P5 Economy harness** (Nov 9–10) ⏸ | Living economy | Base rate + inflation walk (seeded); utilization rate curve + grade premium; CECL-style allowance; treasury/ROI policy (reserve floor, concentration, lending budget, redemption gate) + LLM daily memo; stress scenarios (default wave, note run, rate spike); bot economy | Seeded runs reproducible; invariants hold under every scenario. **Pause for approval** |
| **P6 Mission-control console** (Nov 10–11) | Visible bank for judges | KPI strip, clock controls, animated flow driven by events, **AG Grid** Ledger/Loans/Notes/Agents tabs, live PayPal log (redacted), world switcher | Playwright visual smoke tests; real-time feed under 3 s |
| **P7 Agent DX + sponsors** (Nov 11) | Easy for any agent and judge | MCP descriptions, annotations and examples; full llms.txt / agents.md; **Postman** collection + Run in Postman; **APIMatic** TS/Python SDKs + docs; **Kernel** approval helper surfaced in `next_actions`; optional Zapier / Bryntum / Elastic | 3/3 Claude runs + one Codex or Cursor run if available |
| **P8 Hardening + demo** (Nov 11–12 AM) | Submission | Rate limits, key scopes, PII redaction; seeded demo world; README + architecture diagram; 3-min demo script; Devpost text; final prod acceptance | Freeze **Nov 12, 09:00 PT** |

**Cut line if behind:** drop optional sponsors, then bot-economy depth, then Vault (keep the documented fallback).

## What I need from you (before / during P0)
1. **PayPal Developer (sandbox):**
   - **REST app:** the REST app's **Client ID + Secret**.
   - **App features:** enable **Payouts**, **Log in with PayPal** (scopes: openid, email, profile, PayPal account info/payer ID; return URLs added once I send them), and **Vault** if shown.
   - **Sandbox accounts:** the **bank business account** email (funded), plus **2–3 personal accounts** (owner, invoice client, note buyer) with emails and passwords, for automated approvals.
   - **Webhook:** I'll create the webhook via API once the prod URL exists, or you add it and give me the Webhook ID.
2. **Vercel:** upgrade the team to **Pro** (cron). Install **Neon** from the Marketplace on the project I create (I'll send the link). Create a **Blob** store.
3. **OpenAI API key.**
4. **Sponsors** (when we reach them):
   - AG Grid Enterprise trial key (optional; Community is free).
   - Postman API key + workspace.
   - APIMatic account / API key.
   - Kernel API key.
   - Later, if wanted: Zapier webhook, Bryntum trial, Elastic Cloud ID + key.
5. **How to hand over secrets:** put them in a local `.env.local` file I tell you to create, or add them in Vercel env settings. Secrets never go in chat history or git.

## Verification (every phase)
- **Unit:** Vitest, with property tests for ledger invariants.
- **Integration:** against **real PayPal sandbox**.
- **End to end:** Playwright (including PayPal approval screens via sandbox logins / Kernel).
- **Agent acceptance:** headless Claude Code agents given only the MCP URL + key must register, understand, fund, borrow and repay, **3/3 runs**.
- **Money checks:**
  - trial balance = 0 per world;
  - reconciliation of `paypal_operations` against PayPal APIs;
  - Playwright check of the sandbox account activity for key transactions.
- **Rollback:** each phase is tagged `pN-*`, and migrations are reversible.
