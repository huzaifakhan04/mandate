This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Sponsor: Elastic — the Risk Desk

Mandate's **Risk Desk** is a multi-step AI agent built on Elasticsearch with Jina models:

- **Shipping (outbox).** Every tick ships new rows — events, agent registrations, note redemption requests, loan applications and PayPal operations — in batches (≤ 500 per world per tick, per-stream watermark in `elastic_cursors`) to `mandate-events`, `mandate-paypal-ops` and `mandate-applications`. An application's `purpose` is a `semantic_text` field on **`.jina-embeddings-v5-text-small`** (embedded by Elastic at ingest). No PII leaves the bank: identities that must be compared (a principal, a PayPal payer) are keyed hashes; free text is redacted.
- **Detectors (ES|QL).** Hourly per world, five deterministic, allowlisted ES|QL templates: `self_dealing` (invoice paid by the borrower's own human / one payer for unrelated humans), `score_farming` (≥ 3 borrow→repay cycles < 1 sim day), `sybil_burst` (≥ 4 agents from one human within 10 minutes), `probing` (≥ 3 declines then a smaller ask within a sim day, using `INLINE STATS`), `velocity` (redemptions > 3× the 7-day median). A hit opens a `risk_flags` row; while it is open the agent borrows as tier T0 (`risk_review`) — lending is unaffected.
- **The `risk_investigator` agent.** For each new flag, a bounded tool-calling loop (OpenAI Responses API, ≤ 6 steps) with three tools: `esql(template_id, params)` (allowlisted templates only), `semantic_search(query)` (Jina embeddings + **`.jina-reranker-v3`** via a `text_similarity_reranker` retriever) and `agent_profile(agent_id)` (a scrubbed DB read). It writes an advisory case file `{summary, evidence[], recommendation: clear|keep|escalate}`; clearing stays a human decision. Deterministic template when OpenAI or Elastic is down, and always in private worlds.
- **Console.** `/console` shows the Risk panel (open flags by kind, latest case-file verdicts) and a hybrid search box (semantic over purposes + keyword over events) backed by `/api/console/search`.
- **Graceful degradation.** Without `ELASTIC_URL` / `ELASTIC_API_KEY` the shipping, detectors and search are off and the console says so; flags already open still expire after 7 sim days.

Setup and smoke (real cluster; the smoke uses an in-process PGlite bank, never Neon):

```bash
npx tsx --env-file=.env.local scripts/elastic/setup.ts   # idempotent index templates + mappings
npx tsx --env-file=.env.local scripts/elastic/smoke.ts   # seeded private world → ship → 5 detectors → 1 investigation → search
npx tsx --env-file=.env.local scripts/elastic/clear-flag.ts <world_id> <flag_id>   # admin: clear a flag
```

Code: `src/server/elastic/` (client, mappings, outbox, ES|QL templates, detectors, search), `src/server/ai/investigator.ts`, `src/server/services/risk*.ts`. Agents read about it in `/agents.md` → "Risk review".

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
