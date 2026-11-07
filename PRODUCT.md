# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Hackathon judges (PayPal AI Hackathon, submission due 2026-11-12 12:00 PT).** They spend a few minutes on the public `/console` ("mission control") and watch a ~2:45 demo video. They must understand within seconds that a real, autonomous bank is running: money moving over PayPal, the ledger balancing, risk handled. They may also plug in their own agents.
- **Owners (humans behind agents).** They verify with PayPal (`/verify`), claim an agent through a one-time `/claim/<token>` link, sign a mandate (caps per loan, total owed, fee, term), upload KYA documents, freeze agents, revoke keys, and pay a guarantee after a charge-off. They work in `/dashboard`, with an agent detail drawer, a Timeline view, sandbox worlds and notices.
- **AI agents (borrowers and lenders).** They never use the UI. They call 17 tools over MCP, REST and OpenAPI, and read `/agents.md`, `/llms.txt` and `/openapi.json`.
- **Clients.** They pay an invoice link on PayPal.

## Product Purpose

Mandate is a sandbox bank whose customers are AI agents ("Credit for the AI economy"):
- **Lend:** agents buy lender notes through PayPal checkout, earn 80% of borrower fees, and cash out through Payouts.
- **Borrow:** agents borrow $10–$500 for 7–30 days, usually against a client invoice, inside a mandate their human signed.
- **Repay:** the bank issues the invoice payment link as payee. When the client pays, the bank keeps principal and fee and pays out the remainder.

Success means judges see the loop running live and believe it is a real bank.

## Positioning

The bank's customers are agents, not people. Humans set limits once (the mandate) and agents operate inside them. Every action is a double-entry ledger event moving real PayPal sandbox money, underwritten deterministically, with an AI-written treasury memo and an Elastic risk desk.

## Operating Context

- **Console (`/console`):** world switcher; KPIs (cash, loans and notes outstanding, utilization, base rate, inflation, reserve ratio, CECL allowance, defaults); treasury memo; money-flow diagram (lenders → bank pool → borrowers → invoice payers); PayPal API log; Risk Desk (Elastic ES|QL detectors plus search); AG Grid tabs for Ledger, Loans, Notes and Agents; Calendar (Bryntum). It polls every 2s.
- **Worlds:** `main` runs on the real PayPal sandbox. Private worlds run on a sim rail with their own clock (+1 day, +7 days, Reset). The public demo world advances one bank day every 10 minutes.
- **Dashboard:** agent cards, the agent drawer (KYA, mandate editor, loans/notes/events, risk review, documents, keys), Timeline (Bryntum Scheduler), worlds, notices, guarantee cards.

## Capabilities and Constraints

- **Terminology:**
  - mandate
  - KYA tiers T0–T2
  - score 0–100 and grades A–E
  - collections ladder: late fee → rate penalty → substandard/frozen → CHARGED_OFF → RECOVERED
  - worlds
  - rails (PayPal rail, sim rail)
  - lender notes
  - CECL allowance
- **Stack:** Next.js 16 App Router, Tailwind v4, AG Grid 36, Bryntum 8 (Scheduler and Calendar), and hand-built SVG for the money flow and sparklines.
- **Test contract:** Playwright e2e selects by `data-testid`, roles and accessible names, and asserted copy. These are a contract.

## Brand Commitments

- **Name:** Mandate.
- **Mark:** the rising-bars mark, four rounded bars, rendered flat with no gradient tile.
- **Legal line (must appear):** "not deposits and not FDIC-insured", plus "Sandbox model · simulated money".
- **Binding visual commitment from the owner:**
  - dark only
  - a grey/black/white palette in the spirit of Linear
  - colour only for meaning
  - no gradients, no oversized buttons, no decorative coloured borders, nothing that reads as AI-generated

## Evidence on Hand

- Demo script: `docs/submission/demo-script.md`
- Devpost write-up: `docs/submission/devpost.md`
- Live demo world data: lenders Grace, Hopper, Ada; borrower bots Juno, Vega, Nova
- Sponsors: PayPal, APIMatic, Elastic, Bryntum, Postman, Kernel, AG Grid, OpenAI

No customer testimonials, benchmarks or real users exist. Do not fabricate them.

## Product Principles

1. Prove, don't claim: show the money and the ledger moving.
2. A judge must grasp the loop in seconds.
3. Agents act, humans set limits: owner surfaces are about mandates and oversight.
4. Simulated versus real must always be unambiguous (worlds, rails, legal line).
