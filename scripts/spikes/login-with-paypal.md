# Spike: Log in with PayPal (and its fallback)

## 1. Authorize URL (primary path)

Built `https://www.sandbox.paypal.com/signin/authorize` with:
- `client_id=<PAYPAL_CLIENT_ID>`
- `response_type=code`
- `scope=openid email https://uri.paypal.com/services/paypalattributes`
- `redirect_uri=<PUBLIC_BASE_URL>/api/auth/paypal/callback`

Fetched with `redirect: "manual"` (no browser needed — the failure happens
before any login form renders). Result: **HTTP 200** with PayPal's generic
error page:

> Sorry about that
> Looks like this action is not supported. Please return and report this
> error so that we can support it in the future. (invalid client_id or
> redirect_uri)

This matches the expectation in the task brief: `PUBLIC_BASE_URL`'s
`/api/auth/paypal/callback` was never registered as a return URL for this
app, and registering one requires developer.paypal.com, which is
region-blocked for the human on this project. **Fallback needed, as
anticipated.**

## 2. Fallback: "Verify with PayPal" ($0.01 order + capture)

Script: `scripts/spikes/verify-with-paypal.ts`. Creates a $0.01 order,
drives headless Chromium (Playwright) to the `approveUrl`, logs in as
`PAYPAL_OWNER_EMAIL`, approves, captures, and reads `payer.email_address`
/ `payer.payer_id` off the captured order.

**Result: BLOCKED, not a script defect.** The PayPal sandbox login
rejected the `PAYPAL_OWNER_EMAIL` / `PAYPAL_OWNER_PASSWORD` combination
from `.env.local` with PayPal's own banner: *"Some of your info isn't
correct. Please try again."* The order itself was created successfully
(`orders.create` returned a valid `approveUrl`), so this is specifically
a credential problem with the stored sandbox password, not the
order/capture code path.

The same symptom hit `PAYPAL_CLIENT_EMAIL` / `PAYPAL_CLIENT_PASSWORD` in
the `payee-routing` spike (see `docs/spikes.md`) — after a couple of
failed attempts while debugging the login form automation, that sandbox
account also started returning PayPal's rate-limit message: *"It looks
like you've tried too many times. Try again later, or reset your
password."*

**Action needed from Huzaifa:** confirm/reset the sandbox personal
account passwords for `PAYPAL_OWNER_EMAIL` and `PAYPAL_CLIENT_EMAIL` in
the PayPal sandbox (business.sandbox.paypal.com test accounts), update
`.env.local`, and allow the client account's temporary lockout to clear
before re-running `payee-routing.ts` / `verify-with-paypal.ts`. No
further login attempts were made against either account in this session
to avoid compounding the lockout.

Since the fallback's buyer-login step never completed, `payer.email_address`
/ `payer.payer_id` were not observed in this run. The code path to read
them (`getRawOrder(orderId).payer`) is written and ready to confirm once
a working password is supplied — PayPal's Orders v2 capture response is
documented to include `payer.email_address` and `payer.payer_id` for an
approved order, so once login succeeds this is expected to pass.

**Status: BLOCKED on sandbox credentials (not a code issue).**
