# Day-1 PayPal spikes (Task 7)

All spikes ran against PayPal sandbox REST (`PAYPAL_BASE_URL =
https://api-m.sandbox.paypal.com`) using an in-memory PGlite db
(`scripts/spikes/_helpers.ts#spikeDb`), so none of these writes landed in
the real Neon `paypal_operations` table. Run any script with:

```
npx tsx --env-file=.env.local scripts/spikes/<name>.ts
```

Production deploy: `https://agentic-bank-mu.vercel.app` (publicly
reachable, no deployment protection). Preview deploys are gated by
Vercel Authentication, which is expected/fine.

**Root cause of the initial sandbox-login failures (spikes c/e, below):**
the `*_PASSWORD` values in `.env.local` contained a literal `#`. Both
`node --env-file` and dotenv-style parsers treat an unquoted `#` as a
comment, so everything after it was silently dropped — the script was
submitting a truncated password, which PayPal correctly rejected. Fix:
quote every `*_PASSWORD` value in `.env.local`. Those passwords were
never needed by the deployed app at runtime (only by local
Playwright-driven spikes), so they were removed from Vercel entirely
rather than re-added quoted. Separately, the bank's sandbox business
account was renamed from a name containing "Bank" (PayPal's sandbox
rejects business names containing "Bank") to **"Mandate"**, and a
`PAYPAL_BANK_PASSWORD` was added (quoted) to `.env.local` for
completeness, though no spike currently logs into the bank account
directly.

## a. token-and-order (`scripts/spikes/token-and-order.ts`)

- Command: `npx tsx --env-file=.env.local scripts/spikes/token-and-order.ts`
- Result: order created, `status: PAYER_ACTION_REQUIRED`, `approveUrl`
  present (`rel: payer-action`/`approve` link resolved).
- Example ids: order `3BR00230BD593582L`.
- Time: ~3.1s end-to-end (OAuth token mint + order create).
- **Pass.** No fallback needed.

## b. payout (`scripts/spikes/payout.ts`)

- Command: `npx tsx --env-file=.env.local scripts/spikes/payout.ts`
- $1.00 payout to `PAYPAL_OWNER_EMAIL`. Batch id `NMXV4VY7GX4UA`, item
  `NG2H7W8MGF4VS`.
- `send` response: `PENDING` immediately (~2.5s).
- Poll log (10x @ 3s): `PENDING` (t=6.4s, 10.7s) -> `PROCESSING`
  (t=14.9s-26.4s, item `UNCLAIMED` from ~t=22s) -> `SUCCESS`
  (t=30.3s onward, item stays `UNCLAIMED` since the owner sandbox account
  never actually claims it from this spike).
- **Pass.** Batch reaches `SUCCESS` in ~30s from send. Item status
  `UNCLAIMED` is expected for a payout to an account that hasn't linked
  a card/claimed the balance — not a failure.

## c. payee-routing (`scripts/spikes/payee-routing.ts`)

- Command: `npx tsx --env-file=.env.local scripts/spikes/payee-routing.ts [client|lender|owner]`
  (buyer account selectable via CLI arg, default `client`; added so a
  temporarily rate-limited account can be swapped out without editing
  the script).
- **First attempt (`client`, before the `#`-in-password fix):** order
  created fine with `purchase_units[0].payee.email_address =
  PAYPAL_BANK_EMAIL` (order id `1MD28854GH5106907`), but buyer approval
  via headless Playwright login as `PAYPAL_CLIENT_EMAIL` failed —
  PayPal's own *"Some of your info isn't correct. Please try again."*
  banner (truncated password, root-caused below). After a few retries
  while debugging the form automation, that account hit PayPal's own
  rate limit: *"It looks like you've tried too many times. Try again
  later, or reset your password."* No guest/card checkout option was
  offered at the `approveUrl` landing page.
- **Re-run after the password fix, using `lender` (the client account
  was still presumed rate-limited, so the payer account was switched
  rather than retried):** full pass.
  - Order id `10F302363V728613C`, buyer logged in as
    `PAYPAL_LENDER_EMAIL` successfully.
  - Capture: id `9AK70291S7102635Y`, `status: COMPLETED`, amount
    `$1.50`, `seller_receivable_breakdown.net_amount: $0.96` (after
    PayPal's $0.54 fee).
  - Raw order after capture confirms `purchase_units[0].payee.email_address
    = PAYPAL_BANK_EMAIL` (the bank's sandbox business account) — the
    payee override lands money in the bank account as intended, not the
    buyer or a default merchant.
  - `payer.email_address`/`payer.payer_id` also present on the order
    (lender's sandbox identity).
  - Time: ~19s end-to-end (order create + Playwright login/approve +
    capture + order re-fetch).
- **Pass** (on the second run, with the lender account). The original
  `client`-account failure was a sandbox-login/credential issue, not a
  code or rail-routing defect — `orders.create`'s `payeeEmail` param was
  already correct, as the successful lender run confirms.

## d. vault (`scripts/spikes/vault.ts`)

- Command: `npx tsx --env-file=.env.local scripts/spikes/vault.ts`
- `POST /v3/vault/setup-tokens` with `payment_source.paypal`
  (`usage_type: MERCHANT`) + return/cancel `experience_context` URLs.
- Result: **201**, `status: PAYER_ACTION_REQUIRED`, setup token id
  `4XC10372K4809984K`, an `approve` link returned.
- Time: ~3.1s.
- **Pass — unexpectedly.** The brief predicted
  `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE`; this sandbox app actually has
  vaulting enabled, so the setup-token call succeeds outright. No
  fallback needed. (Completing the vault — approving the setup token and
  exchanging it for a payment token — was not attempted here since it
  would need the same buyer-login flow blocked in spike c/e.)
- **P4 (Ruling P4-G, cut line): no vault auto-debit is built.** The
  setup token works, but a saved-payment-method capture was cut from P4.
  Collection is by payment link only, which was the documented fallback:
  the invoice link, a `repay_loan` checkout, and after charge-off the
  owner's guarantee link (PayPal in the main world, the sim approve page
  in a private world). `/agents.md` → "When you're late" says the bank
  never debits automatically.

## e. login-with-paypal (`scripts/spikes/login-with-paypal.md`,
   `scripts/spikes/verify-with-paypal.ts`)

Full writeup: `scripts/spikes/login-with-paypal.md`. Summary:

- **Primary (OAuth "Log in with PayPal") authorize URL:** hit
  `https://www.sandbox.paypal.com/signin/authorize` with
  `scope=openid email https://uri.paypal.com/services/paypalattributes`
  and `redirect_uri=<PUBLIC_BASE_URL>/api/auth/paypal/callback`. Result:
  **HTTP 200** with PayPal's own error page: *"Sorry about that ...
  (invalid client_id or redirect_uri)."* Expected — the return URL was
  never registered (no developer.paypal.com access). **Fallback
  required, as anticipated.**
- **Fallback ("Verify with PayPal"), `verify-with-paypal.ts`:** $0.01
  order approved by `PAYPAL_OWNER_EMAIL` via headless Playwright, then
  captured, reading `payer.email_address`/`payer.payer_id` off the
  order.
  - **First attempt (before the `#`-in-password fix): FAIL** — same
    truncated-password symptom as spike c: PayPal rejected the login
    with *"Some of your info isn't correct. Please try again."* No
    further attempts were made against this account in that run, to
    avoid triggering the same lockout seen on the client account.
  - **Re-run after quoting the passwords in `.env.local`: PASS.** Owner
    login succeeded (`approval.ok: true`). Capture `3UA71900VF7082636`,
    `status: COMPLETED`, `$0.01`. `payer.email_address` and
    `payer.payer_id` are both present on the order (the owner's sandbox
    identity) — confirming the "Verify with PayPal" fallback's design
    works end to end. This run also hit (and fixed) the `BigInt`
    serialization bug noted below.
- Time: ~15s for the first (failed) attempt; a similar time for the
  passing re-run.
- **Pass**, once run with corrected credentials.

### BigInt serialization bug (found during the re-run, now fixed)

The first successful re-run of `verify-with-paypal.ts` crashed at the
final `console.log(JSON.stringify(captured))` with `TypeError: Do not
know how to serialize a BigInt` — `CaptureOrderResult.amountCents` is a
`bigint`, which the built-in `JSON.stringify` can't handle. Fixed by
adding `safeJson()` to `scripts/spikes/_helpers.ts` (a `JSON.stringify`
wrapper with a bigint-to-string replacer) and switching every spike
script's logging over to it, not just the one that happened to hit the
bug — `orders.capture`'s `amountCents` is the only bigint field returned
by any of these calls today, but `payout.send`/`payout.get` and
`orders.create` results were switched too for consistency/future-proofing.

## f. openai-models (`scripts/spikes/openai-models.ts`)

- Command: `npx tsx --env-file=.env.local scripts/spikes/openai-models.ts`
- `GET /v1/models`: **200**, 98 models.
- All four candidate ids exist: `gpt-5.6-terra`, `gpt-5.6-luna`,
  `gpt-6-astra`, `gpt-5.6-sol`.
- Closest available chat/reasoning models observed: the `gpt-5.x` family
  (`gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5-pro`, `gpt-5.1`, `gpt-5.2`,
  `gpt-5.2-pro`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.4-pro`,
  `gpt-5.5`, `gpt-5.5-pro`), the `gpt-4.1`/`gpt-4o` family, and the `o3`
  reasoning family (`o3`, `o3-pro`).
- Time: ~1.9s.
- **Decision:** `OPENAI_MODEL_UNDERWRITER=gpt-6-astra` (the only
  non-`5.6` / newest major-version model available — treated as the
  strongest flagship for underwriting explanations) and
  `OPENAI_MODEL_CHECK=gpt-5.4-nano` (an established "nano" tier id,
  i.e. the cheapest well-known naming pattern available, used for cheap
  pass/fail checks). The `/v1/models` endpoint doesn't expose pricing or
  capability metadata, so this is a naming-convention judgment call, not
  a verified price comparison — worth revisiting once real usage/cost
  data is available. Set in `.env.local` and Vercel (all three
  environments).

## g. ai-roles (`scripts/spikes/ai-roles.ts`, P3 Task 3, 2026-11-06)

- Command: `npx tsx --env-file=.env.local scripts/spikes/ai-roles.ts` — one
  real Responses API call per role through `runRole` (strict
  `json_schema` structured output, `store: false`, no retries, 20 s
  timeout), logged to `ai_runs` in an in-memory PGlite db (never Neon).
- Results (one run each; all schema-valid and within policy, so
  `fallback_used = false`):

  | Role | Model | Latency | Tokens in / out |
  |---|---|---|---|
  | kya_desk | `gpt-5.4-nano` (`OPENAI_MODEL_CHECK`) | 4.3 s | 305 / 71 |
  | loan_officer | `gpt-6-astra` (`OPENAI_MODEL_UNDERWRITER`) | 7.7 s | 571 / 156 |
  | risk_officer | `gpt-6-astra` (`OPENAI_MODEL_UNDERWRITER`) | 4.9 s | 356 / 207 |

- Cost: well under 1k tokens per call, ~1.7k tokens for a full
  application (loan + risk officer). The API returns usage, not prices;
  per-token prices for these ids aren't exposed by `/v1/models`, so cost
  is tracked as tokens in `ai_runs.tokens_in/out`.
- Latency 4–8 s is well inside the 20 s timeout but too slow for the
  request path — confirms the design: AI runs after commit (`finalize` /
  `after()`), with the deterministic template as fallback.
- Output quality: the loan officer reused exactly the two input reasons in
  order; the KYA desk flagged a kind/file-name mismatch as `needs_info`
  (advisory only — the P2 auto-review stays authoritative).

## Webhook registration

- `POST /v1/notifications/webhooks` with `url =
  https://agentic-bank-mu.vercel.app/api/webhooks/paypal` and the full
  event list from the brief (`CHECKOUT.ORDER.APPROVED`,
  `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`,
  `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.PAYOUTSBATCH.SUCCESS`,
  `PAYMENT.PAYOUTSBATCH.DENIED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`,
  `PAYMENT.PAYOUTS-ITEM.FAILED`, `PAYMENT.PAYOUTS-ITEM.UNCLAIMED`,
  `PAYMENT.PAYOUTS-ITEM.RETURNED`, `VAULT.PAYMENT-TOKEN.CREATED`).
- Result: **201**, webhook id `09862274TX3614149` (stored as
  `PAYPAL_WEBHOOK_ID` in `.env.local` and Vercel, all three
  environments).
- **Delivery check:** sent a fresh $0.01 payout after the webhook was
  registered (sent at `17:50:11.408Z`). The stub route
  (`src/app/api/webhooks/paypal/route.ts`) logs every POST it receives;
  `vercel logs` confirmed two deliveries:
  - `PAYMENT.PAYOUTS-ITEM.UNCLAIMED` at `17:50:57.514Z` (~46s latency)
  - `PAYMENT.PAYOUTSBATCH.SUCCESS` at `17:50:58.959Z` (~48s latency)
- **Pass.** Webhooks arrive at the prod stub reliably, end-to-end
  latency from PayPal-side state change to our endpoint receiving it is
  in the ~45-50s range for this event type (consistent with the payout
  batch's own PENDING->PROCESSING->SUCCESS timeline from spike b).

## Resolved: sandbox credentials

Both blockers above are now resolved:

- Root cause (`#` truncating `.env.local` passwords) fixed by quoting
  every `*_PASSWORD` value.
- `PAYPAL_OWNER_PASSWORD` / `PAYPAL_CLIENT_PASSWORD` / `PAYPAL_LENDER_PASSWORD`
  were removed from Vercel — they're only used by local Playwright spike
  scripts, never by the deployed app, so they don't belong in the
  runtime environment. **Do not re-add them to Vercel.**
- The sandbox business account was renamed to **"Mandate"** (PayPal's
  sandbox rejects business names containing "Bank"), and
  `PAYPAL_BANK_PASSWORD` was added to `.env.local` (quoted) for
  completeness.
- `PAYPAL_CLIENT_EMAIL` may still be temporarily rate-limited from the
  earlier debugging attempts — `payee-routing.ts` was re-run against
  `PAYPAL_LENDER_EMAIL` instead (now the recommended default to avoid
  hammering a possibly-still-locked account) and passed cleanly;
  `verify-with-paypal.ts` was re-run against `PAYPAL_OWNER_EMAIL` and
  also passed.

Summary: deploy, the REST/MCP tool surface, the webhook pipeline, and
all six day-1 spikes now pass end to end (five on the first pass; two —
payee-routing and the login-with-paypal fallback — on the password-fixed
re-run).
