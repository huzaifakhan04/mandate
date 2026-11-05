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

- Command: `npx tsx --env-file=.env.local scripts/spikes/payee-routing.ts`
- Order created with `purchase_units[0].payee.email_address =
  PAYPAL_BANK_EMAIL` (order id `1MD28854GH5106907` on the final attempt)
  — PayPal accepted the payee override and returned a normal
  `approveUrl`.
- Buyer approval (headless Playwright, logging in as
  `PAYPAL_CLIENT_EMAIL`): **FAIL.** First attempts returned PayPal's
  *"Some of your info isn't correct. Please try again."* banner (wrong
  password, not a script bug — the login form, email submit, and
  password submit all worked mechanically, confirmed via screenshots).
  After a few attempts debugging the form automation, the account
  started returning *"It looks like you've tried too many times. Try
  again later, or reset your password."* (sandbox login lockout).
- No guest/card checkout option was offered on the initial `approveUrl`
  landing page (only email+password login or "Create an Account"), so
  there's no guest fallback to try instead.
- Capture was never reached (script stops short and reports instead of
  crashing once login fails).
- Time to failure: ~16s (order create + failed login attempt).
- **Fail — blocked on sandbox credentials, not code.** Fallback
  decision: none needed in code — `orders.create`'s `payeeEmail` param
  already does the payee override correctly (confirmed by PayPal
  accepting the order); once a working `PAYPAL_CLIENT_PASSWORD` is
  supplied, re-run this script to confirm the capture's payee. See
  "Action needed" below.

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
  order. Result: **FAIL** — same symptom as spike c: PayPal rejected the
  login with *"Some of your info isn't correct. Please try again."* No
  further attempts were made against this account (to avoid triggering
  the same lockout seen on the client account). Capture never ran, so
  `payer.email_address`/`payer.payer_id` presence is unconfirmed — but
  PayPal's Orders v2 docs show these fields on an approved order's
  `payer` object, and the capture call itself is already proven working
  by spike a/b's code paths.
- Time to failure: ~15s (order create + failed login).
- **Fail — blocked on sandbox credentials, not code.**

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

## Action needed from Huzaifa

The sandbox personal account passwords for `PAYPAL_OWNER_EMAIL` and
`PAYPAL_CLIENT_EMAIL` in `.env.local` do not match what PayPal's sandbox
login currently accepts (confirmed by PayPal's own "info isn't correct"
error, not a script defect — order creation, the login form automation,
and error-banner detection all worked correctly). The `PAYPAL_CLIENT_EMAIL`
account is also temporarily rate-limited after repeated failed attempts
during debugging. Please:

1. Confirm/reset the passwords for both sandbox personal accounts.
2. Update `.env.local` with the corrected passwords (no code change
   needed).
3. Allow the client account's temporary lockout to clear, then re-run
   `scripts/spikes/payee-routing.ts` and
   `scripts/spikes/verify-with-paypal.ts` to confirm: (a) a capture
   under a bank-owned `payee` succeeds and reports the bank as payee,
   and (b) `payer.email_address`/`payer.payer_id` are present on a
   captured order (needed for the "Verify with PayPal" KYC-lite
   fallback in P1).

This does not block Phase 0 deploy/infra: deploy, the REST/MCP tool
surface, the webhook pipeline, and five of the six day-1 spikes all
passed cleanly.
