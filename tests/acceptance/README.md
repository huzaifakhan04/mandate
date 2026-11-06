# Agent acceptance harness

Headless Claude Code agents that know only the bank's URL must fund it, borrow from it and get repaid, using nothing but Mandate's MCP tools (plus `WebFetch` to read `/agents.md`). Phase 1 passes when 3 runs out of 3 succeed against prod.

```sh
# Local: starts `next dev` on in-memory PGlite (a fresh server for each run) and drives the reconcile cron itself
npm run test:agents                     # 1 run
npm run test:agents -- --runs 3

# Remote (e.g. prod): settlement comes from Vercel cron and webhooks; the harness only polls the public tools
npm run test:agents -- --base https://agentic-bank-mu.vercel.app --runs 3
```

`npm run test:agents` is `tsx --env-file=.env.local tests/acceptance/run.ts`.

| Option | Default | Meaning |
| --- | --- | --- |
| `--base <url>` | (none: local) | Bank to test. Without it, a local server is started on `--port` (3140). |
| `--runs <n>` | 1 | Number of independent runs. Each run uses fresh agents. |
| `--model <m>` | CLI default | Passed to `claude --model`. |
| `--max-turns <n>` | 40 | Turn limit for each `claude -p` invocation. |
| `--timeout-min <n>` | 10 | Wall-clock limit for each `claude -p` invocation. |

## Requirements

- The `claude` CLI must be on `PATH` and logged in.
- Playwright Chromium must be installed (`npx playwright install chromium`).
- `.env.local` must define `PAYPAL_CLIENT_ID`/`_SECRET` and `PAYPAL_{LENDER,CLIENT,OWNER}_{EMAIL,PASSWORD}`. Optional: `PAYPAL_OWNER_PAYER_ID` and `PAYPAL_LENDER_PAYER_ID`. Each one you set skips a browser login at startup. Without them, the harness learns each payer ID by having that account approve a throwaway $1.00 order. That order is never captured.

## What one run does

1. **Lender agent.** The prompt (`prompts/lender.md`) gives only the base URL, the goal ("fund the bank with $30"), and "your PayPal account id" (the LENDER payer ID). It also suggests starting at `<base>/agents.md`.
2. **Borrower agent.** The prompt (`prompts/borrower.md`) asks it to "borrow $10 for 7 days against your client's $15 invoice, then give me the payment link". It also gives the client's email, an invoice number, and the OWNER payer ID as the agent's account ID.
3. **Keys, in two phases.** MCP headers are static per config, so each agent runs twice:
   - **Phase A:** the MCP config has no key. The agent registers and prints `API_KEY=<key>` on its own line. The harness parses it.
   - **Phase B:** the harness resumes the same session (`--resume`) with an MCP config that carries `Authorization: Bearer <key>`, sending `prompts/continue.md`.
4. **Human approvals.** The harness scans the agent's reply for `sandbox.paypal.com` links:
   - The lender's checkout is approved as **LENDER**, then the harness resumes with "Approved. Continue."
   - The borrower's payment link must match the loan's open `repayment_link`. The harness pays it as **CLIENT**, falling back to OWNER if PayPal refuses the CLIENT login.
   - If the agent stopped without a link, the harness nudges it ("Continue toward your goal"). It does this at most 6 times per agent.
5. **Settlement.** Locally, the harness calls `POST /api/cron/reconcile` between agent turns and while it waits. Remotely, it only polls `get_loan`. It waits until the loan is `REPAID` and `loan.remainder_paid` appears in the loan's history.
6. **Checks.** These use the public tools, called by the harness with the agents' keys:
   - notes are 3000;
   - the loan has principal 1000 and fee 15, with a 1500 link;
   - the loan ends `REPAID` with 0 outstanding;
   - the borrower's ±485 remainder lines are present;
   - the lender earned 12. This exact value is checked locally only. Remotely, other note holders share the fee, so the check is 1–12.

   Locally, `/api/test/ledger` also checks that the trial balance is 0, that no PayPal operation failed, and that exactly two payouts (disbursement and remainder) succeeded. Remotely, these checks are skipped and the results file says so.
7. **Debrief.** The borrower is told the client paid and asked where things stand. Its answer is recorded but not asserted.

Each `claude -p` invocation runs with these limits:

- MCP: `--strict-mcp-config`, so the `mandate` server is the only one.
- Built-in tools: `--tools WebFetch`.
- Permissions: `--allowedTools "mcp__mandate__*" WebFetch` with `--permission-mode dontAsk`. Allowed tools run without prompts, and everything else is denied.
- Settings: `--setting-sources ""`.
- Working directory: an empty temp directory, so no `CLAUDE.md` is loaded.

## Output

- `tests/acceptance/results/<timestamp>.md` (safe to commit) records, for each run: pass or fail, step timings, the tool calls each agent made, its turn and cost totals, the agent and loan IDs, every check, and notes.
- `test-results/acceptance/` (gitignored) holds the full redacted transcript of each run, the `next dev` logs, and screenshots of failed PayPal approvals.
- API keys (`mnd_…`) and the sandbox account emails are redacted everywhere. Keys exist only in memory and in temp MCP configs (mode 0600), which are deleted after each run.

Claude Code's `WebFetch` can't reach `http://localhost`. In local runs, agents therefore read the bank through the `get_bank_guide` MCP tool rather than `/agents.md`. Against an `https` base, they can fetch `/agents.md` directly.

If PayPal shows a captcha or security challenge, the run stops and reports `BLOCKED`. The harness never tries to get around it.
