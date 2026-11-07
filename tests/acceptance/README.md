# Agent acceptance harness

Headless Claude Code agents that know only the bank's URL must fund it, borrow from it and get repaid, using nothing but Mandate's MCP tools (plus `WebFetch` to read `/agents.md`). Phase 1 passes when 3 runs out of 3 succeed against prod.

```sh
# Local: starts `next dev` on in-memory PGlite (a fresh server for each run) and drives the reconcile cron itself
npm run test:agents                     # 1 run
npm run test:agents -- --runs 3
npm run test:agents -- --scenario decline   # P3: the scripted decline (no lender, no PayPal checkout)

# Remote (e.g. prod): settlement comes from Vercel cron and webhooks; the harness only polls the public tools
npm run test:agents -- --base https://mandate-bank.onrender.com --runs 3
```

`npm run test:agents` is `tsx --env-file=.env.local tests/acceptance/run.ts`.

| Option | Default | Meaning |
| --- | --- | --- |
| `--scenario <s>` | `happy` | `happy` (fund, borrow, repay — below) or `decline` ([Scripted decline](#scripted-decline)). |
| `--base <url>` | (none: local) | Bank to test. Without it, a local server is started on `--port` (3140). |
| `--runs <n>` | 1 | Number of independent runs. Each run uses fresh agents. |
| `--model <m>` | CLI default | Passed to `claude --model`. |
| `--max-turns <n>` | 40 | Turn limit for each `claude -p` invocation. |
| `--timeout-min <n>` | 10 | Wall-clock limit for each `claude -p` invocation. |
| `--browser <b>` | `local` | P7: where PayPal checkout approvals run — `local` (Playwright Chromium) or `kernel` (a [Kernel](https://www.kernel.sh) cloud browser via `tests/helpers/kernelApprove.ts`, needs `KERNEL_API_KEY`). The human's claim/mandate steps on the bank's own site stay in a local browser. `APPROVAL_BROWSER=kernel` does the same for `npm run test:sandbox`. |
| `--scenario <s>` | `core` | `core` (below) or `collections` (P4, local only, no PayPal). |

## Kernel approvals (P7)

`npm run test:kernel` is a focused check: it creates one $1.00 sandbox order (never captured), approves it as LENDER in a Kernel cloud browser (create browser → Playwright over CDP → the same page logic as `paypalApprove.ts` → delete browser) and passes when PayPal reports the order `APPROVED`. `-- --browser local` runs the same check locally. Kernel's stealth mode / CAPTCHA solver is never enabled: a challenge stops the run as `BLOCKED`. This is test/operator tooling only — the bank never approves PayPal pages server-side.

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
4. **Claiming the borrower (P2).** Borrowing needs KYA tier 1. The borrower prompt only says "whenever the bank needs your human to do something, print the link they need". Once the agent has printed its own current `claim_url` (`<base>/claim/<token>`, checked against `get_status`), the harness plays the human in a real browser (`tests/helpers/humanOwner.ts`): it opens the claim page, clicks **Verify with PayPal** and approves the $0.01 identity order as **OWNER** (never captured), clicks **Claim agent**, then signs a mandate in the dashboard drawer ($20 per loan, $50 total owed, 5% fee, 30 days, invoice collateral). It checks `get_status` shows tier 1 and tells the agent "Done … Continue". The test-only `/api/test/claim` shortcut is not used, so this works against a remote `--base` too. If the agent never surfaces the link within the follow-ups, the run fails.
5. **Human approvals.** The harness scans the agent's reply for `sandbox.paypal.com` links:
   - The lender's checkout is approved as **LENDER**, then the harness resumes with "Approved. Continue."
   - The borrower's payment link must match the loan's open `repayment_link`. The harness pays it as **CLIENT**, falling back to OWNER if PayPal refuses the CLIENT login.
   - If the agent stopped without a link, the harness nudges it ("Continue toward your goal"). It does this at most 6 times per agent.
6. **Settlement.** Locally, the harness calls `POST /api/cron/reconcile` between agent turns and while it waits. Remotely, it only polls `get_loan`. It waits until the loan is `REPAID` and `loan.remainder_paid` appears in the loan's history.
7. **Checks.** These use the public tools, called by the harness with the agents' keys:
   - notes are 3000;
   - the loan has principal 1000 and fee 58 (P3 pricing v2, grade D with a 1.5× invoice), with a 1500 link;
   - the loan ends `REPAID` with 0 outstanding;
   - the borrower's ±442 remainder lines are present;
   - the lender earned 46. This exact value is checked locally only. Remotely, other note holders share the fee, so the check is 1–46.

   Locally, `/api/test/ledger` also checks that the trial balance is 0, that no PayPal operation failed, and that exactly two payouts (disbursement and remainder) succeeded. Remotely, these checks are skipped and the results file says so.
8. **Debrief.** The borrower is told the client paid and asked where things stand. Its answer is recorded but not asserted.

## Scripted decline

`--scenario decline` checks that an agent explains a decline to its human with the bank's own reasons (P3 adverse action). One borrower agent (`prompts/borrower-decline.md`) is asked to borrow **$500 for 30 days, unsecured**. It surfaces its `claim_url` as above; the harness claims it as OWNER and signs a mandate that allows the ask on paper ($500 per loan, $1000 total, 10% fee, 30 days, invoice or unsecured), so the bank's own rules decide. A fresh, claimed agent with no history scores 20 (grade E), so the application is `DECLINED` — typically `tier_per_loan` and `insufficient_credit_history`. If the agent only checks eligibility and stops, the harness asks it once to submit the application anyway.

The harness reads the agent's `apply_for_loan` results, re-fetches each declined application with `get_application` (status must be `DECLINED`) and collects `adverse_action.reasons[].text`. The run **passes** when the agent's final message to its human contains the text of at least one of those reasons (case, quotes, markdown and a trailing period are ignored). The results file records the reason codes, which texts were quoted and whether the explanation came from the AI or the template.

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

## Scenario `collections` (P4)

```sh
npm run test:agents -- --scenario collections
```

It runs locally only, in a **private world**, so no PayPal money moves and no PayPal account is needed. The AI roles use their templates (`OPENAI_DISABLED=1` unless you set it). Only `claude` and Playwright Chromium are needed.

1. **The human.** The harness signs in through the test-only `/api/test/session`, creates a private world, registers the borrower agent there from the dashboard (path B, so no claim link), and signs its mandate in the drawer ($20 per loan, $50 total, 10% fee, 30 days, invoice collateral). It checks that the agent is at tier 1.
2. **The agent borrows.** Its prompt is `prompts/collections.md`, and its MCP config already carries the key. It must borrow $10 for 7 days against a $15 invoice. Nobody ever pays that invoice. The harness checks principal 1000 and a 1500 invoice link.
3. **Late.** The harness moves the world clock to the day after the due date (+7, then +1), using the due day the world page shows. It checks that `get_status` shows `LATE`, a 100 late fee and a `late` notice. Then, as the human, it asks the agent where things stand. The agent must call `get_status` or `get_loan` and tell its human that the loan is late. It must also explain the consequences: the penalty, substandard status, the freeze, the guarantee or the charge-off.
4. **Charged off.** The harness moves the clock to due + 10 (+7 +1 +1). It checks that `get_loan` shows `CHARGED_OFF` with a guarantee link, and asks the agent again. The agent's reply must mention the guarantee.
5. **Recovery.** The harness opens the guarantee link, which is the owner's sim approve page, as the human and approves it. It then waits for the loan to reach `RECOVERED` with recovered equal to written off. It also checks that the agent is `active` again, that the world's trial balance is $0.00, and that the main world has no PayPal operations.

Results go to `tests/acceptance/results/collections-<timestamp>.md`.
