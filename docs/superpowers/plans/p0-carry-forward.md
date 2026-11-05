# P0 → P1 carry-forward (from the P0 final whole-branch review)

## Must be the first tasks of P1 (interface changes before any mutating tool)
- **I1 — queued PayPal operations:** split `paypalFetch` into `enqueueOperation(tx, …)` (insert pending row inside the domain transaction) and `executeOperation(db, id)` (never inside a transaction); store an executable (unredacted, sandbox-only) request or rebuild from domain rows; distinguish `failed_terminal` (definite 4xx) from `failed_retryable` (5xx/timeout/unknown outcome); add `claimed_at`, `next_attempt_at` (additive migration); reconcile cron claims rows.
- **I2 — tool context:** add `db` (+ scoped helpers) to `ToolCtx`; auth step in `RunToolDeps` returning `{agentId, worldId}` (world comes from the API key); mutating tools get idempotency (`idempotency_keys`) + one transaction around the handler in `runTool`; memoise `ensureMainWorld` (not every request); derive GET support from `mutating:false` instead of the hardcoded `get_bank_guide`.
- **I4 — operation ids:** `operationId?` on `orders.capture` / `CaptureCheckoutParams`; `deriveOperationId(worldId, purpose, sourceId)` (UUIDv5) using the same `purpose:sourceId` string as the journal idempotency key; treat `ORDER_ALREADY_CAPTURED` as success after GET order.
- **I5 — scoped():** add `select(table, where?)`, `findOne`, `insertOnConflictDoNothing`, `delete`; add a lint/grep test that flags direct `.from()/.insert()` on world tables outside an allowlist (ledger, paypal, auth); document `simApprove` as the exception.

## Carry (minor)
- M1 `docs_url` → `/agents.md` 404 until P1 ships agents.md.
- M2 replays don't compare request params/postings; replayed PayPal results return redacted bodies.
- M3 sim failed payout replayed as failed forever vs PayPal rail re-sends.
- M4 Neon: `attachDatabasePool` (@vercel/functions); run migrations over `DATABASE_URL_UNPOOLED`; document prod migration step.
- M5 `@electric-sql/pglite` likely traced into prod bundles — devDependency or `outputFileTracingExcludes`.
- M6 indexes: `postings(entry_id)`, `postings(world_id, account_id)`, `paypal_operations(world_id, kind, paypal_id)`; composite FK so postings can't reference another world's account.
- M7 webhook stub: signature verification (P1), size/content-type limits.
- M8 CI: add `next build` + e2e/MCP smoke.
- M9 spike scripts log raw responses (sandbox payer email/payer_id).
- INVALID_REQUEST reason code is "root" for unknown keys — include key names/issue codes.
- Test hygiene: vitest advisory warnings (`resolve.tsconfigPaths`, `.mts` config); share PGlite per file beyond fetch.test.ts.
- `createWorld` slug collision has no retry (36^6 space; fails loudly).
- OpenAPI uses a generic envelope schema (no per-tool `data`).
- OpenAI model choice was by naming convention (`gpt-6-astra` / `gpt-5.4-nano`) — revisit pricing in P3.
- Bank sandbox email: `mandate.bank.p0a@example.com` added as an unconfirmed secondary (cannot confirm without developer dashboard); primary remains the original sb- address.
