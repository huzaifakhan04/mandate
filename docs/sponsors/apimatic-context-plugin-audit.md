# APIMatic Context Plugin for PayPal — integration audit of Mandate

Mandate (a sandbox bank for AI agents on PayPal) was audited and hardened with the
**APIMatic Context Plugin for PayPal** (`npx context-plugins install paypal`, plugin v0.4.1), whose
`paypal:typescript-*` skills are the lookup + usage layer for the APIMatic-generated PayPal TypeScript
SDK. Ground truth for every "plugin says" cell: the SDK map the plugin points at
(`context-plugins/paypal-typescript-sdk` v2.29.0 — `sdk-map.md`, `map/operations/orders.md`,
`src/models/*.ts`), cross-checked against the official `@paypal/paypal-server-sdk@2.5.0` `.d.ts` models,
which Mandate now depends on. Contract sheet: [`paypal-plan.md`](../../paypal-plan.md).

## Skills used and what each one decided

| Skill | Outcome |
| --- | --- |
| `typescript-getting-started` | Lookup layer: SDK identity, the single host (`serverOptions.baseUrl` ↔ our `PAYPAL_BASE_URL`), the resource list — **Orders only; no Payouts, no webhook verification** — and the map/model file table used for every row below. Confirmed the `Order.payer` @deprecated note. |
| `typescript-integrate-paypal` | Workflow: plan + contract sheet first (`paypal-plan.md`), durable-write / unknown-outcome / optional-field tables. The 1b.3 "optional fields need a reason" rule drove the `user_action`/`shipping_preference` decision and the "no invented keys" test. |
| `typescript-models` | Wire-key renaming (`_keysMap`), open enums, required vs optional members → the type-level `Wire<T>` adoption in `src/server/paypal/sdkTypes.ts`; "a truncated 2xx decodes cleanly — assert what you depend on" confirmed our `requireString` guards. |
| `typescript-calling-endpoints` | Per-operation fields/defaults: `prefer` defaults to `return=minimal` (we must keep sending `return=representation`); `payPalRequestId` exists on create/capture but **not** on `getOrder` → fix 3. |
| `typescript-error-handling` | Error body `{name, message, debug_id, details[].issue}`; 2xx decode failure = **unknown outcome**, not failure → confirmed capture recovery and payout retryable; 401/403/429 vs caller 4xx mapping confirmed. |
| `typescript-authentication` | OAuth client-credentials: Basic auth + form body, single-flight cache, refresh before expiry, 401 invalidates; token response is **schema-decoded, not cast**; missing `expires_in` handled → fix 4. |
| `typescript-configuration-resilience` | Retry/timeout/idempotency model: per-attempt timeout + whole-call deadline, writes retried only with a caller-owned idempotency key spanning calls → confirmed our 15 s/attempt + 60 s total + `PayPal-Request-Id` = derived op id; "never stack retry layers / unknown write outcome must be re-read" → fix 5. |
| `typescript-client-initialization` | Long-lived, module-scoped token cache (serverless warm reuse) confirmed; "there is no webhook surface — verifying is yours" confirmed our postback verifier design. |
| `typescript-testing` | Stub in **wire shape**, assert the request actually sent (headers included), cover non-`ApiError` failures (bad token body, decode) → `tests/unit/paypal/apimaticAudit.test.ts` with fixtures typed by the SDK models. |

## SDK adoption decision

**Adopted: the official SDK's models and enums as the compile-time contract** for every Orders v2 body
we build or parse (`Wire<OrderRequest>`, `Wire<Order>`, `Wire<OrdersCapture>`, the `CustomError` body,
`OrderStatus`/`CaptureStatus`/`PaypalExperienceUserAction`/`PaypalWalletContextShippingPreference`
enum values). `Wire<T>` re-applies the SDK's camel→snake `_keysMap` renaming at the type level, so a
misspelled wire key or an invalid enum value in a builder, parser or test fixture is a compile error.
Type-only imports: zero bytes added to the server bundle.

**Not adopted: the SDK's HTTP call path**, because it would break binding rulings:

1. *Stored request shapes / queued operations (Rulings F, H).* Every PayPal call is a
   `paypal_operations` row whose wire request (`executable_request`) is persisted inside the domain
   transaction and re-sent verbatim after commit — possibly by the reconcile cron in another process.
   The SDK builds the request from a camelCase model at call time; there is no "send this stored wire
   request" entry point.
2. *Exactly-once via derived `PayPal-Request-Id`.* The SDK mints its own `Idempotency-Key` per call
   (`RequestOptions` has no per-call header override); only `PayPal-Request-Id` spans calls, and the
   SDK can carry it on create/capture, but **not** on Payouts (not in the SDK at all).
3. *Raw status for our classifier.* A malformed 2xx becomes a `DecodeError` (the raw body is gone),
   but capture/payout recovery must classify "2xx unparseable" as *unknown outcome* and re-read; the
   SDK's typed arms also do not carry the raw body we redact and store.
4. *Sim rail parity.* The sim rail answers the same wire `{httpStatus, body}` in-DB; routing it
   through the SDK would need a fake `fetch` per row — two code paths where Ruling F demands one.
5. *Coverage.* Payouts (send/get/item cancel) and webhook signature verification are not in the SDK.

## Call-by-call audit

Verdicts: **ok** (matches the plugin), **fixed** (discrepancy fixed in this branch, with a test),
**accepted** (deliberate deviation, reason given).

| Call | What Mandate does | What the plugin / SDK says | Verdict |
| --- | --- | --- | --- |
| OAuth `POST /v1/oauth2/token` | Basic `client_id:secret`, `grant_type=client_credentials` form body; module-level cache refreshed 60 s before expiry; single-flight; 401 → force refresh once and retry the same request | Same Basic + form shape; cache until 30 s before expiry; single-flight; 401 invalidates (SDK does *not* re-send the current call) | **ok** (our skew is wider; our immediate 401 re-send is safe because the request id is reused) |
| OAuth response parsing | Was `res.json() as {access_token, expires_in}` — a 2xx without `access_token` cached `undefined` and sent `Bearer undefined`; missing `expires_in` gave `NaN` expiry → a token request on every call | SDK decodes the token response against a schema; missing `expires_in` ⇒ cached until a 401 | **fixed** (fix 4): schema-style validation → `PayPalOAuthError`; missing `expires_in` cached 5 min (bounded, not forever) |
| Credentials missing | `PayPalConfigError` at first call, op stays `failed_retryable`, nothing sent | "Missing credentials must stop the app from starting" | **accepted**: sim/private worlds run without PayPal; a world never boots PayPal rail without creds, and a queued op completes once creds exist |
| Orders `createOrder` body | `intent: CAPTURE`, one purchase unit `{amount{currency_code USD, value "12.34"}, description, custom_id, payee?}`, `payment_source.paypal.experience_context{return_url, cancel_url}` | `OrderRequest{intent, purchaseUnits, paymentSource?}`; `application_context` is the legacy path; `experience_context` is current | **ok** — now typed `WireOrderRequest` (compile-checked) |
| Orders `experience_context.user_action` | Absent → PayPal default `CONTINUE` ("you will review the order on the merchant site") even though every checkout is captured immediately on return | `PayPalExperienceUserAction`: CONTINUE (default) vs PAY_NOW — "final amount known … process the payment immediately" | **fixed** (fix 1): `PAY_NOW` for captured checkouts; `CONTINUE` kept for the never-captured $0.01 identity order |
| Orders `experience_context.shipping_preference` | Absent → default `GET_FROM_FILE`: PayPal asks a lender/borrower for a shipping address for a bank deposit | `PayPalWalletContextShippingPreference`: GET_FROM_FILE (default) · NO_SHIPPING · SET_PROVIDED_ADDRESS | **fixed** (fix 1): `NO_SHIPPING` |
| Orders headers | `PayPal-Request-Id` = derived op id on every attempt; `Prefer: return=representation` on POST | `createOrder`/`captureOrder` declare `payPalRequestId` + `prefer` (default `return=minimal`) | **ok** — representation is required for the capture fee breakdown (Task 10b) |
| Orders `createOrder` response | `id`, `status`, link `rel` `approve` **or** `payer-action` → approve URL | `Order{id?, status?, links?: LinkDescription{href, rel, method?}}`; `payment_source` orders return `PAYER_ACTION_REQUIRED` + `payer-action` | **ok** |
| Orders `captureOrder` | POST, no body; `purchase_units[0].payments.captures[0]{id, status, amount.value, seller_receivable_breakdown{gross_amount, paypal_fee, net_amount}}`; capture status kept distinct from order status | Body optional; `OrdersCapture.status: CaptureStatus` (COMPLETED·DECLINED·PARTIALLY_REFUNDED·PENDING·REFUNDED·FAILED); breakdown "not available for transactions in pending state" | **ok** (PENDING → null fees, re-observed by cron) |
| Orders `captureOrder` errors | `ORDER_ALREADY_CAPTURED` in `name` or **any** `details[].issue` → recover via GET; 2xx unparseable → recover via GET; recovery failure → retryable, never terminal | Error arms 400/401/403/404/422/500/default all `Error{name, message, debug_id, details[].issue}`; 2xx `DecodeError` = unknown outcome, re-read by reference | **ok** |
| Orders `getOrder` headers | Sent `PayPal-Request-Id` (a random UUID) on every GET | `Orders.GetOrderRequest` = `id`, `fields`, mock + auth-assertion headers — **no `PayPal-Request-Id`** (it is a write idempotency key) | **fixed** (fix 3): GET sends neither `PayPal-Request-Id` nor `Prefer` |
| Orders `getOrder` payer | Read only `payer.{payer_id, email_address, name}` | `Order.payer` is **@deprecated**: "details … are now available under `payment_source.paypal`" (`account_id`, `email_address`, `name`) | **fixed** (fix 2): read `payment_source.paypal` first, fall back per field to legacy `payer` |
| Orders status enums | `PAYER_ACTION_REQUIRED`, `APPROVED`, `COMPLETED` drive settlement; unknown values pass through as strings | `OrderStatus` is an **open** enum (CREATED·SAVED·APPROVED·VOIDED·COMPLETED·PAYER_ACTION_REQUIRED) — `switch` needs a default | **ok** (unknown status = keep polling) |
| Error shape (all) | Stored `{name, issue: details[0].issue, message, debugId, details (redacted)}`; specific codes matched across all `details[]` | `Error{name, message, debug_id, details?: {issue, field?, value?, location?, description?}[]}` | **ok** — `WirePayPalError` now types it from the SDK's `CustomError` |
| Retry / timeout | 15 s per attempt (`PAYPAL_TIMEOUT_MS`), ≤ 2 inline retries on 5xx/network with 300/900 ms backoff, 60 s whole-call deadline; then op-level backoff 30 s·2ⁿ ≤ 10 min; 401/409/429 retryable, other 4xx terminal | Per-attempt timeout ≠ call budget — bound the call with a deadline; retry writes only with a caller-owned idempotency key reused across attempts; do not stack retry layers | **ok** — both layers resend the *same* `PayPal-Request-Id`, so stacking is safe here; `Retry-After` not read (accepted: op backoff floor is 30 s) |
| Payouts `POST /v1/payments/payouts` | Single-item batch, `sender_batch_id` = `PayPal-Request-Id` = derived op id; `recipient_type` EMAIL/PAYPAL_ID/PHONE; amount `{value, currency}`; 2xx unparseable → retryable | **Not in the SDK** (plugin: mark UNVERIFIED; PayPal REST docs) | **ok** |
| Payouts duplicate batch | A 4xx "batch with given `sender_batch_id` already exists" (an earlier attempt reached PayPal outside the request-id replay window) was classified **terminal** → the payout would be booked as failed although money moved | Plugin rule: a write whose outcome may have taken effect is *unknown*, never *failed* — settle by re-reading | **fixed** (fix 5): duplicate-batch / `DUPLICATE_REQUEST_ID` 4xx → `failed_retryable` (Ruling V anomaly), other 4xx still terminal |
| Payouts `GET /v1/payments/payouts/{id}` | `batch_header{payout_batch_id, batch_status, fees}`, `items[]{payout_item_id, transaction_status}`; settlement by item status (Rulings J, R) | Not in the SDK | **ok** |
| Payouts-item cancel `POST …/payouts-item/{id}/cancel` | UNCLAIMED only; result item `RETURNED` | Not in the SDK | **ok** (sends `PayPal-Request-Id`; harmless if ignored — cancel is naturally idempotent) |
| Webhook verification `POST /v1/notifications/verify-webhook-signature` | 5 transmission headers + `webhook_id` + parsed event; 8 s deadline; `SUCCESS` → verified; 5xx/401/429/network → 503 (redeliver); missing headers/id → fail closed; unverified bodies never stored | "There is no webhook surface — verifying is entirely yours"; never treat "SDK parsed" as "verified" | **ok** (postback re-serializes the event, as PayPal's own SDKs do — accepted, documented in `webhooks.ts`) |
| Vault | None in Mandate | SDK has `client.vault` | **n/a** |
| Logging / secrets | `redact()` on every stored request/response/webhook; no PayPal bodies logged | SDK logs JSON bodies verbatim if `logRequestBody`; keep it off | **ok** |
| "Never call PayPal inside a DB transaction" | Static guard test `noTransactionCalls.test.ts`; enqueue in tx, execute after commit | Plugin 1b.1: claim (own store) → call → record result | **ok** — the claim is the `paypal_operations` PK |

## Fixes in this branch (all with msw tests in `tests/unit/paypal/apimaticAudit.test.ts`)

1. `experience_context.user_action = PAY_NOW` (CONTINUE for identity verification) and
   `shipping_preference = NO_SHIPPING` — `src/server/paypal/orders.ts`, `src/server/services/principals.ts`.
2. Payer read from `payment_source.paypal` (SDK: `payer` deprecated) with per-field legacy fallback.
3. No `PayPal-Request-Id` / `Prefer` on GETs — `src/server/paypal/fetch.ts`.
4. OAuth token response validated; missing `expires_in` cached — `src/server/paypal/token.ts`.
5. Payout duplicate `sender_batch_id` = unknown outcome, never a failed payout — `src/server/paypal/operations.ts`.
6. `src/server/paypal/sdkTypes.ts`: `Wire<T>` over `@paypal/paypal-server-sdk` models; order builder and
   parsers typed by it.

Sim rail parity: unchanged semantics — the sim reads the same request bodies (it ignores
`experience_context`) and answers with the legacy `payer`, which the parser still reads.

## Real-sandbox verification

`npm run test:sandbox` against real PayPal sandbox after these changes: **1/1 passed in 280 s** — identity verify, notes checkout + capture, loan payout, invoice approve + capture, repayment, remainder payout; 14 operations, 2 payout batches, 305¢ PayPal fees journaled, no reconcile errors. (Run notes: `.superpowers/sdd/p7-paypal/report.md`, local only.)
