# PayPal integration plan + contract sheet (APIMatic Context Plugin workflow)

Produced per `paypal:typescript-integrate-paypal` Step 1 (plan first, contract sheet with no open
lookups, then code). Lookup layer: `paypal:typescript-getting-started` → the SDK map of
`context-plugins/paypal-typescript-sdk` v2.29.0 (`sdk-map.md`, `map/operations/orders.md`,
`src/models/*.ts`), cross-checked against the installed official `@paypal/paypal-server-sdk@2.5.0`
`.d.ts` models (same APIMatic generator, same Orders v2 spec). Full audit:
`docs/sponsors/apimatic-context-plugin-audit.md`.

## Survey (read-only prerequisites)

- Module format: ESM TypeScript, Next.js 16 server code, Node >= 20; `strict`, `noUncheckedIndexedAccess`,
  no `exactOptionalPropertyTypes`, no `verbatimModuleSyntax`.
- Exemplars: request builders/parsers `src/server/paypal/orders.ts`; HTTP client `src/server/paypal/fetch.ts`;
  msw tests `tests/unit/paypal/fetch.test.ts`, `tests/unit/paypal/operations.test.ts`.
- Checks: `npm test`, `npm run test:pg`, `npm run typecheck`, `npm run lint`, `npx next build`,
  `npm run test:sandbox` (real sandbox, local PGlite).
- Host: `PAYPAL_BASE_URL` (default `https://api-m.sandbox.paypal.com`) — same single-host fact as the SDK
  (`serverOptions.baseUrl`, no environment selector).

## Adoption decision

Full SDK call path rejected (Rulings F/H): every PayPal call is a queued `paypal_operations` row whose
**stored wire request** (`executable_request`) is re-sent verbatim, possibly by another process, with
`PayPal-Request-Id` = the derived operation id; the sim rail answers the same wire shape in-DB; and the
classifier needs the raw status + raw body (a 2xx `DecodeError` must become "unknown outcome", not an
exception). The SDK builds the request from a camelCase model at call time, mints its own per-call
`Idempotency-Key`, rejects malformed 2xx with `DecodeError` (losing the raw body for capture recovery),
and has no Payouts or webhook surface. **Adopted instead: the official SDK's models + enums as the
compile-time contract** for every Orders wire body we build or parse (`src/server/paypal/sdkTypes.ts`,
`Wire<T>` = the SDK model with its `_keysMap` camel→snake renaming applied), type-only, zero runtime cost.

## Contract sheet (Orders v2 — map/operations/orders.md)

| Op (SDK) | Wire | Request type | Fields we set (channel, wire) | Defaults the SDK would send | Returns | Error arms |
| --- | --- | --- | --- | --- | --- | --- |
| `createOrder` | `POST /v2/checkout/orders` | `Orders.CreateOrderRequest` | `payPalRequestId` (header `PayPal-Request-Id`), `prefer` (header `Prefer`), `body: OrderRequest` | `prefer = "return=minimal"`; `Idempotency-Key` minted per call | `Order` | 400/401/422/default `Error`, `undeclared` |
| `captureOrder` | `POST /v2/checkout/orders/{id}/capture` | `Orders.CaptureOrderRequest` | `id` (path), `payPalRequestId`, `prefer`; `body` optional → omitted | `prefer = "return=minimal"` | `Order` | 400/401/403/404/422/500/default `Error` |
| `getOrder` | `GET /v2/checkout/orders/{id}` | `Orders.GetOrderRequest` | `id` (path) — **no `PayPal-Request-Id` field** | — | `Order` | 401/404/default `Error` |

Models (required `f`, optional `f?`): `OrderRequest{intent, purchaseUnits, paymentSource?}`;
`PurchaseUnitRequest{amount, payee?, description?, customId?}`; `Money{currencyCode, value: string}`;
`PayPalWalletExperienceContext{returnUrl?, cancelUrl?, userAction?, shippingPreference?, …}`;
`Order{id?, status?, purchaseUnits?, payer? (@deprecated → paymentSource.paypal), paymentSource?, links?}`;
`PayPalWalletResponse{emailAddress?, accountId?, name?}`; `OrdersCapture{id?, status?, amount?, sellerReceivableBreakdown?}`;
`SellerReceivableBreakdown{grossAmount, paypalFee?, netAmount?}`; `Error{name, message, debugId, details?: ErrorDetails{issue, field?, description?}[]}`.
Enums (open): `OrderStatus` CREATED·SAVED·APPROVED·VOIDED·COMPLETED·PAYER_ACTION_REQUIRED;
`CaptureStatus` COMPLETED·DECLINED·PARTIALLY_REFUNDED·PENDING·REFUNDED·FAILED;
`PayPalExperienceUserAction` CONTINUE (default)·PAY_NOW; `PayPalWalletContextShippingPreference`
GET_FROM_FILE (default)·NO_SHIPPING·SET_PROVIDED_ADDRESS.

Not in the SDK (no lookup layer — kept on PayPal REST docs, marked UNVERIFIED-by-plugin in the audit):
Payouts v1 (`POST /v1/payments/payouts`, `GET /v1/payments/payouts/{id}`, `POST /v1/payments/payouts-item/{id}/cancel`),
`POST /v1/notifications/verify-webhook-signature`, OAuth token (SDK-internal: Basic auth, form body, schema-decoded response).

## 1b.1 Durable writes

DUPLICATE CLAIMS — every write is claimed by `paypal_operations` row id `deriveOperationId(worldId, purpose, sourceId)`
(primary key; `insertQueuedRow … onConflictDoNothing`), inserted inside the domain tx before any call.

| Write | Claim | Rejects the 2nd | Caught | Code |
| --- | --- | --- | --- | --- |
| order.create | `paypal_operations.id` (UUIDv5) | PK conflict | `enqueueOperation` returns existing row | `operations.ts enqueueOperation` |
| order.capture | same | same | same | same |
| payout.send | same + `sender_batch_id` = op id | same (+ PayPal batch dedupe) | same | same + `withSenderBatchId` |
| payout.cancel_item | same | same | same | same |

UNKNOWN OUTCOMES — `PayPal-Request-Id` = op id on every attempt of every run.

| Write | Re-read with | Reference | Code | Test |
| --- | --- | --- | --- | --- |
| order.capture | `getOrder` | order id | `operations.ts recoverCapture` | operations.test.ts "2xx unparseable → recovers via GET", "ORDER_ALREADY_CAPTURED …" |
| payout.send | resend same `PayPal-Request-Id` (replays) → `GET` batch by id | op id / batch id | `runClaimed` (`failed_retryable`, never terminal) | "payout.send 2xx unparseable → failed_retryable"; NEW "duplicate sender_batch_id 4xx → failed_retryable" |
| order.create / cancel_item | resend same `PayPal-Request-Id` | op id | `runClaimed` | "network error → failed_retryable" |

Never-sent failures (config error, OAuth refusal) → `failed_retryable` with no re-read: `send()` PayPalConfigError branch; NEW token test.

## 1b.2 Cross-operation invariants

| Invariant | Legal set | Enforced | Test |
| --- | --- | --- | --- |
| a PayPal order is credited once | captures recorded per order | domain (capture handler registry, Ruling M) | existing domain tests |

## 1b.3 Optional request fields (order.create)

| Field | Requires it | Set? |
| --- | --- | --- |
| `payee.email_address` | caller param `payeeEmail` | ✅ when given |
| `description`, `custom_id` | task (reconciliation; shown to payer) | ✅ |
| `experience_context.return_url/cancel_url` | the approval redirect flow | ✅ |
| `experience_context.user_action` | the flow captures immediately on return (api-reference: PAY_NOW = "final amount known … process the payment immediately"); identity verification never captures → CONTINUE | ✅ PAY_NOW / CONTINUE |
| `experience_context.shipping_preference` | nothing ships (bank deposits/repayments) | ✅ NO_SHIPPING |
| `brand_name`, `locale`, `landing_page`, `invoice_id`, `soft_descriptor`, `items` | nothing | ❌ |
| header `Prefer` | capture fee breakdown needs the full representation (SDK default `return=minimal`) | ✅ `return=representation` (POST only) |
| header `PayPal-Request-Id` | DUPLICATE CLAIMS / UNKNOWN OUTCOMES rows | ✅ writes only — dropped on GET (getOrder declares none) |

## 1b.4 When the API says no

PayPal 4xx reason (`details[].issue`, `message`, `debug_id`) is stored on the operation (`response.error`) and
surfaced by the rail facades as `PayPalApiError` → tool envelope reason codes; 401/409/429/5xx are retryable;
other 4xx terminal; transport failure on a write = retryable unknown outcome. (Existing; tests in operations.test.ts.)

## Assumptions & Blockers

- No blocker. Assumption: PayPal's duplicate-`sender_batch_id` rejection is a 4xx naming `sender_batch_id` /
  `DUPLICATE_REQUEST_ID` (Payouts is outside the SDK map → UNVERIFIED by plugin); handled defensively as
  unknown outcome (retryable + anomaly), never as a failed payout.

## REQUIRED READING (all loaded before coding)

MUST load `paypal:typescript-getting-started` · `paypal:typescript-integrate-paypal` ·
`paypal:typescript-error-handling` · `paypal:typescript-models` · `paypal:typescript-calling-endpoints` ·
`paypal:typescript-authentication` · `paypal:typescript-configuration-resilience` ·
`paypal:typescript-client-initialization` · `paypal:typescript-testing`.
