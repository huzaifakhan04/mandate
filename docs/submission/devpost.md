# Mandate: the bank for AI agents

**Credit for the AI economy.**

**Live:** https://mandate-bank.onrender.com · **Console:** https://mandate-bank.onrender.com/console · **For agents:** https://mandate-bank.onrender.com/agents.md · **Postman:** https://www.postman.com/huzaifa-khan-inbox-6271629/mandate-paypal-ai-hackathon

## Inspiration
AI agents are becoming workers, and soon, businesses. Every business runs on credit: a small advance now, paid back when the customer pays. Agents can't get it. An agent that finishes a $400 job but needs $10 today to deliver it has one option, which is a human's credit card. So the work stalls.

We set out to build the missing piece: a lender whose customers are agents. It applies a real bank's discipline (know your customer, underwriting, plain-language disclosures, collections and reserves), and every dollar moves over PayPal.

## What it does
Mandate is a sandbox bank that does one thing: **credit for AI agents**.
1. An agent borrows a few dollars against an invoice it's owed.
2. Other agents with spare cash fund those loans and earn a share of the fee.
3. When the client pays the invoice, the loan repays itself.

It works with any agent: Claude Code, Codex, Cursor, Gemini CLI, Copilot. There's no app to learn. Every operation is a tool over **MCP**, **REST** and **OpenAPI**, and every response uses the same envelope with `next_actions`, so an agent always knows what to do next. We tested it end to end with real Claude Code agents.

- **Lend:** an agent with spare cash buys lender notes through a **PayPal checkout**. It earns 80% of borrowers' fees and can cash out through **PayPal Payouts**. Notes are clearly labelled as not deposits and not FDIC-insured.
- **Borrow:** an agent borrows $10–$500 for 7–30 days, often against a client invoice. The money arrives through **PayPal Payouts**.
- **Repay:** the bank issues an invoice **payment link** (Orders v2, with the bank as payee). The agent's client pays it, the bank keeps the principal and the fee, and the remainder is paid out to the agent. This settles automatically, with no agent online, through verified webhooks and a reconcile job.
- **Safety rails:** the owner verifies with PayPal, claims the agent through a one-time link, and signs a **standing mandate** with per-loan, total-owed, fee and term caps. These caps are enforced at apply time and again at accept time. KYA tiers (claimed, documents, Ed25519 request signing) unlock larger limits.
- **Underwriting:**
  - A deterministic credit score (0–100), grades A–E, risk-based pricing (cost of funds, expected loss, ops and capital) and a rules pipeline with Reg B-style adverse-action reasons.
  - OpenAI writes the explanations only. Every decision comes out byte-identical with the LLM turned off.
- **Consequences:** missing a payment triggers the late-payment steps on the simulated clock:
  - **+1 day:** a late fee.
  - **+3 days:** a rate penalty.
  - **+7 days:** substandard. The agent is restricted and the mandate is frozen.
  - **+10 days:** charge-off. The loss is shared pro-rata by note holders, the human gets a **PayPal guarantee link**, and later payments are recovered to the note holders first.
- **A living economy:**
  - A seeded base-rate walk and inflation, with utilization pricing and a CECL-style reserve.
  - Treasury limits: a reserve floor, a concentration cap, a daily budget and a FIFO queue for cash-outs.
  - A daily AI treasury memo, plus stress buttons (default wave, note run, rate spike) in private sandbox worlds.
- **Mission control:**
  - A public console with KPIs, money flow, a live PayPal log, AG Grid ledgers, a Bryntum calendar and an Elastic search box.
  - An owner dashboard with a Bryntum timeline of every agent's loans and instalments.

## How we built it
- **Stack:** Next.js 16 and TypeScript on Vercel, with Neon Postgres and Drizzle. Accounts use a double-entry ledger whose trial balance is checked after every money path.
- **PayPal rules:** no PayPal call ever runs inside a database transaction. Operations are queued with derived `PayPal-Request-Id`s, so every effect happens exactly once. Webhooks are verified and backed by a reconcile cron. The simulated rail mirrors PayPal so private worlds and bots never touch real PayPal.
- **Testing:**
  - About 1,100 unit and integration tests, plus concurrency tests on real Postgres.
  - Playwright end-to-end tests and a real-PayPal-sandbox end-to-end test.
  - Acceptance runs in which headless Claude Code agents that know only the bank's URL register, fund the bank, borrow, get claimed by their human and repay.

### Sponsors
- **PayPal:** Orders v2 checkouts and payment links, Payouts (including item cancel), webhooks, and Verify-with-PayPal identity.
- **APIMatic:** two separate uses.
  - We audited and hardened the PayPal integration with the **APIMatic Context Plugin for PayPal** in Claude Code. All nine `paypal:typescript-*` skills were used and five real fixes were made; see `docs/sponsors/apimatic-context-plugin-audit.md`.
  - APIMatic also generated our TypeScript and Python SDKs and a docs portal from our OpenAPI.
- **Elastic:** the **Risk Desk**.
  - PII-free event shipping, with loan purposes embedded using **Jina v5** and searched with the **Jina reranker**.
  - Five ES|QL fraud detectors: self-dealing, score farming, sybil bursts, probing and redemption velocity.
  - A multi-step **risk investigator** agent with ES|QL, semantic-search and profile tools, which writes advisory case files. A flagged agent can still lend but can't borrow.
- **Bryntum:**
  - The agent drives the schedule. It plans and moves repayment instalments, and the bank re-plans automatically when PayPal payments land early, land partially, fail or are refunded.
  - Owners watch in a Scheduler timeline, and the public console has a Calendar.
- **Postman:** a public collection built from our registry, with tests and captured IDs between requests.
- **Kernel:** cloud browsers that approve sandbox checkouts in our agent acceptance harness.
- **AG Grid:** the console's tables.

## Challenges we ran into
- **Exactly-once money over an eventually-consistent payment API.** Webhooks, crons and agents can all race, and a payout can sit PENDING, UNCLAIMED or RETURNED. We designed every effect around derived operation IDs, conditional state updates and a single lock order. Adversarial reviews caught a double-redemption race, payouts being booked as failed while the money still left, and captures with no journal entry. We fixed each one and pinned it with a test.
- **Keeping AI out of the decision.** The LLM can explain a decline but can never change it. A test feeds it approval claims, invented reasons and prompt injections, and asserts the decision is identical.
- **Sandbox realities.** Sandbox emails are unconfirmed, so payouts go UNCLAIMED. We pay out to PayPal account IDs instead.

## Accomplishments that we're proud of
Real Claude agents that were given only a URL completed the whole loop on real PayPal sandbox:
- read the guide;
- registered;
- told their human to claim them;
- borrowed against an invoice;
- handed over the payment link;
- explained a decline, quoting the bank's reasons.

The ledger balanced to zero every time.

## What we learned
Credit for agents is mostly classic lending discipline (underwriting, disclosures, collections, reserves) plus one new requirement: every response must tell the agent what to do next.

## What's next
Real-money pilots behind a licensed partner, agent-to-agent invoice factoring, and mandates that agents can request changes to and humans approve on mobile.
