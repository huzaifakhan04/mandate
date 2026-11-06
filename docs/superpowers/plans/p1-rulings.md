# SDD ledger — plan: docs/superpowers/plans/2026-11-06-p1-core-loop.md
Branch p1-core-loop, base 1f6e5b8 (main dbee367). Spec: docs/superpowers/specs/2026-11-05-mandate-design.md

## Pre-flight scan
| Pair / task | Produces → consumes | Finding |
|---|---|---|
| T1 → T2,T5–T8 | runTool tx + ctx.afterCommit → services enqueue in tx, execute after commit | consistent |
| T2 → T5–T8 | enqueueOperation(tx)/executeOperation(db)/deriveOperationId/journalKey | consistent |
| T3 → T5,T6 | scoped().forUpdate → liquidity lock | consistent (T3 before T5) |
| T3 guard ↔ T4–T8 services | guard allowlist excludes services | Ruling A |
| T4 → T5,T6 | note series seed + note_interest_expense | consistent |
| T5 → T7,T8 | registerCaptureHandler; redemption payout outcome | T5 leaves redemption-outcome fn unnamed → Ruling B |
| T6 → T8 | applyPayoutOutcome(db, opId) | Ruling B |
| T7 → T8 | applyRepaymentCapture; link orders polled by cron | consistent |
| T9 ↔ all | registry-generated docs | consistent |
| T10/T11 → T12 | local runs then prod | consistent |
| T1 self | idempotency_keys columns may not fit (P0 schema) | Ruling C |
| T6 self | pricing goldens recomputed: 750/7821, 15, 2500 cap | agrees |
| T7/T10 self | 14250 & 600; 485 & 12 | agrees |
| others self | | agree |

Ruling A: services in src/server/services/** must use scoped() (incl. forUpdate) for world tables; ledger/paypal/rail/auth stay allowlisted — keeps isolation enforceable — cost: a few extra scoped methods.
Ruling B: T5 exports applyRedemptionPayoutOutcome(db, opId); T6 exports applyPayoutOutcome(db, opId) for loan disbursements and also routes remainder payouts; T8 adds dispatchPayoutOutcome(db, opId) switching on operation purpose — names needed by T8 — cost: rename if wrong.
Ruling C: T1 may add a migration altering idempotency_keys (request_hash, response jsonb, http_status, agent_id) if P0 columns don't fit — plan needs it — cost: one migration.

## Tasks
Task 1: dispatched (sonnet), BASE 1f6e5b8
Task 1: implemented 5c82278 (impl agent a9873e415ae1d0999); review dispatched (opus)
Task 1: review (opus) Needs fixes — I1 mutating⇒agent invariant breaks register_agent; I2 concurrent same-key → 500. Fix round 1 sent (resume impl) incl. minors 3–8.
Ruling D: auth:'none' mutating tools run in tx but skip idempotency — no agent scope to key on — cost: register_agent retries create duplicate agents (acceptable; plan says no dedupe).
Ruling E: DB agent statuses lowercase; API may present uppercase — P0 schema already lowercase — cost: casing translation in T4.
Task 1: fix round 1 be58c22; scoped re-review dispatched (sonnet)
Task 1: re-review all addressed (be58c22)
Task 1: complete (5c82278, be58c22)
Ruling F: executeOperation dispatches by row.rail ('paypal' → paypalFetch; 'sim' → simRail in-DB handler); orders/payouts modules become request builders + response parsers used by both enqueue and execute — keeps one code path — cost: refactor of P0 callers.
Task 2: dispatched (sonnet), BASE be58c22
Task 2: implemented 9df1cac (impl a2ae2d5f120940e5f); concern: sim dispatch placeholder; review dispatched (opus)
Task 2: review (opus) Needs fixes — I1 sim placeholder; I2 stale in_flight never reclaimed (plan-mandated SQL bug); I3 capture-recovery GET failure → false terminal; I4 split status bookkeeping + attempts reset; I5 result shape differs first-run vs replay; I6 grep guard misses rail/*; minors 7–11.
Ruling G: fix round 1 goes to a FRESH opus implementer (not resume) — redesign of bookkeeping ownership is architecture-level and the sonnet impl stubbed the core requirement — cost: re-reading context.
Ruling H: operations.ts owns ALL status/attempts/backoff writes for every PayPal call; paypalFetch becomes a pure HTTP client (token, retries, timeouts, Request-Id) that returns outcomes and writes no rows; rails' direct methods go through enqueue+execute too (no second path). Stored `response` = one parsed, JSON-safe result shape per kind (bigints as strings), returned identically on first run and replay.
Task 2: fix round 1 dispatched to fresh opus implementer (ab28345bac9374b6b)
Task 2: fix round 1 232dead; re-review dispatched (opus, redesign-sized)
Task 2: re-review r1 — all 8 addressed; NEW Important: 2xx unparseable on capture/payout → terminal. Fix round 2 sent (resume opus) + minors: details[] scan, 60s fetch deadline + 3min stale window, backoff growth on 0-attempt failures. Parked: GET Request-Id header (harmless), sim jsonb lookup (perf).
Carry to T6/T8 briefs: payout outcome = read item transactionStatus (fail receiver → succeeded op, FAILED item). Carry to T5/T7: domain must prevent crediting one PayPal order twice (ALREADY_CAPTURED recovery treats any capture as success).
Task 2: fix round 2 1b72901; re-review dispatched (sonnet)
Task 2: re-review r2 all addressed
Task 2: complete (9df1cac, 232dead, 1b72901). Parked: token fetch not aborted at deadline (benign); GET Request-Id header; sim jsonb lookup perf; old P0 succeeded rows keep raw response shape.
Task 3: dispatched (sonnet), BASE 1b72901
Task 3: implemented 46c6984 (impl a86f923da89039b48); review dispatched (sonnet)
Task 3: review Needs fixes — delete/forUpdate optional where (whole-world delete footgun); guard misses multi-line + db.query. Fix round 1 sent (resume impl). Parked: import-alias blind spot.
Task 3: fix round 1 b4ebfe3 — controller verified diff directly (where required on delete/forUpdate; whole-text \s* regex + .query. pattern + fixtures).
Task 3: complete (46c6984, b4ebfe3)
Task 4: dispatched (sonnet), BASE b4ebfe3
Task 4: implemented f0a0625 (impl a6d44ddd53d6e2fa5); review dispatched (sonnet)
Task 4: review Approved (minor: comment on "unknown" defaults — parked)
Task 4: complete (f0a0625). Note: payout destination = agents.payoutReceiver/payoutReceiverType.
Ruling I: rail per world — worlds row decides ('paypal' for main when PayPal configured; tests/bot worlds 'sim'). If worlds lacks a rail column, add `rail text not null default 'paypal'` (migration) and a helper railForWorld(db, worldId) in services/worlds.ts — needed by every money tool — cost: one column.
Ruling J: payout settlement = item transactionStatus: SUCCESS → apply effect; FAILED/UNCLAIMED/RETURNED/BLOCKED/REFUNDED → failure effect; PENDING/UNCLAIMED-in-progress → leave pending for the T8 cron (payout.get poll). Effects idempotent via journalKey + conditional status update.
Task 5: dispatched (sonnet), BASE f0a0625
Ruling I (amended): use existing worlds.rail_mode via railForWorld(db, worldId); no new column.
Ruling K: tools whose response needs a post-commit PayPal result (approve URL) use a new runTool `finalize(envelope, ctx)` hook run after commit; idempotency stores the finalized envelope; on execute failure return PENDING with confirm_checkout next action (which re-executes create) — keeps "no PayPal in tx" — cost: one more runTool hook.
Task 5: implemented ee521e7 (impl acf5e4037530f0118); review dispatched (opus). Attribution now Co-Authored-By only (no Claude-Session) from here on.
Task 5: review (opus) Needs fixes — C1 double redemption (own pending not subtracted); C2 live payout item null → booked failed; I1 two-tx effects; I2 _pending leak + finalize failure stored as 500; I3 terminal capture loops; I4 fail-open ownership. Fix round 1 sent (resume impl) incl. minors 1,2,3,5.
Ruling L: tool-level `idempotent` flag; confirm_checkout = false (naturally idempotent by order id; storing AWAITING_APPROVAL would freeze polling).
Ruling M: capture-handler registry entry = {resolveOwnerAgentId, applyEffect, applyFailure} required together; missing → NOT_FOUND (fail closed).
Task 5: fix round 1 a9ea716; re-review dispatched (opus)
Task 5: re-review r1 — M2 replay returns COMPLETED; C1 race between position read and settlement; OOS: captureStatus not checked; order.get terminal → PENDING forever. Fix round 2 sent (resume impl).
Carry to T8: review-state note txs hold unjournaled captured cash — reconcile must list them (suspense journal or refund later).
Ruling N: lock order = note_series row, then note_positions row, for every notes path (begin redemption, settle redemption, purchase effect) — prevents deadlock + C1 race.
Task 5: fix round 2 fc2916e; re-review dispatched (sonnet)
Task 5: re-review r2 all addressed
Task 5: complete (ee521e7, a9ea716, fc2916e). Parked: purchase path locks position only (no deadlock, asymmetric); M2 review-state cash unjournaled (→T8).
Ruling O: T6+ money tasks use OPUS implementers — sonnet implementations of T2 and T5 each shipped criticals; opus saves fix rounds — cost: tokens.
Task 6: dispatched (opus), BASE fc2916e
Task 6: implemented b27e295 (impl aba459295db5a5864); review dispatched (opus)
Ruling P: loan due = disbursement sim time + term_days (borrower gets the full term); disclosure must say so — field `due_date` renamed/labelled `estimated_due_date` plus `due_rule: "<term_days> days after funds are sent"`; hash covers both — cost: disclosure shape change.
Task 6: review (opus) Needs fixes — I1 Ruling P missing; I2 appliers can't see live payout status (send body item null forever); I3 failed loan shows outstanding; I4 UNCLAIMED treated terminal though still claimable. Minors 1–4.
Ruling Q: applyPayoutOutcome / applyRedemptionPayoutOutcome take optional `observed?: { itemStatus: string; source: 'webhook'|'poll' }`; when absent they use the latest succeeded payout.get read op for the same batch (newer than send) else the send body. T8 webhook passes observed; cron enqueues+executes payout.get then calls the applier — cost: signature change in notes too.
Ruling R: UNCLAIMED is NOT terminal: keep liquidity reserved; enqueue a payout item cancel (new op kind payout.cancel_item, POST /v1/payments/payouts-item/{item_id}/cancel, sim support) and treat the item as failed only once it is RETURNED (cancel succeeded / status RETURNED). Terminal set becomes FAILED/RETURNED/BLOCKED/REFUNDED/DENIED. Applies to loans and redemptions — cost: one new op kind.
Task 6: fix round 1 sent (resume opus impl)
Task 6: fix round 1 5c371fb; re-review dispatched (opus)
Task 6: re-review r1 — all 8 addressed; NEW Important: pollPayoutStatus unbounded rows. Fix round 2 sent (guard + backoff throttle, dedupe reasons, DECLINED next-action args, read ordering).
Carry to T8: UNCLAIMED item whose cancel failed_terminal stays reserved ~30d — reconcile should list it.
Task 6: fix round 2 5d49e2b — controller verified diff (guard, backoff, result reasons, tie-break). 
Task 6: complete (b27e295, 5c371fb, 5d49e2b). Parked: throttle clock skew (negligible).
Ruling S: T7 exposes `settleCheckoutByOrderId(db, worldId, orderId)` (agent-less: GET order → capture if APPROVED → dispatch to handler) used by confirm_checkout internals, T8 webhook (CHECKOUT.ORDER.APPROVED / CAPTURE.COMPLETED) and T8 cron — Review Focus 3 requires settlement with no agent online — cost: refactor of finalizeConfirmCheckout.
Task 7: dispatched (opus), BASE 5d49e2b
Task 7: implemented 5f8254f (impl a9137f3bf9713b514); review dispatched (opus)
Ruling T: accept implementer's choices — interest credited to position units (redeemable); liquidity also subtracts payable_to_borrower (cash owed to borrowers isn't lendable — the plan formula missed it); lock order series → loan → positions.
Carry to T8: webhooks route via settleCheckoutByOrderId; cron executes queued link creates, polls open link orders, polls remainder payouts; failed remainder payout / missing receiver needs a retry path (T8: reconcile lists + retry on receiver set).
Task 7: review (opus) Approved. Polish round sent (cumulative holders' share, get_loan description, test hook reset, description spacing).
Carry to T8: failed invoice links never re-issued; failed/held remainders no retry; webhook-activated loans' link create stays queued (cron must execute queued ops); remainder UNCLAIMED path untested for remainder_payout. T8 names: settleCheckoutByOrderId, applyRepaymentCapture(db, worldId, simNow, {...}), pollPayoutStatus.
Task 7: polish d9e6986 (cumulative holders' share etc.)
Task 7: complete (5f8254f, d9e6986)
Task 8: dispatched (opus), BASE d9e6986
Task 8: implemented bff79f9 (impl ae405a87a5ba17ba8); review dispatched (opus)
Task 8: review (opus) Needs fixes — I1 PENDING capture never re-observed (money captured never credited; burns budget). Fix round 1 sent (+ M2 job_runs only-when-active, M3 order.get paypal_id index, M4 stale guard, M5/M6 comments, M8 verify deadline/maxDuration). Parked M7 budget fairness → P8.
USER (2026-11-06): no more approval waits — P1 and P5 pauses waived; build+test all phases continuously, merge/tag/deploy per phase; single summary at end.
Task 8: fix round 1 1d77082; property.test timeout was load (controller re-ran alone: pass 21.7s). Re-review dispatched (sonnet).
Task 9: dispatched (sonnet) in parallel with T8 re-review (reviewer read-only), BASE 1d77082
Task 8: re-review all addressed
Task 8: complete (bff79f9, 1d77082). Parked: M7 budget fairness (P8).
Task 9: implemented 27346e7 (impl a0be51aaa2b119c6b); review dispatched (sonnet)
Task 10: dispatched (opus) in parallel with T9 review, BASE 27346e7
Task 9: review Approved (minors parked: docs.ts size, toolAnchor identity)
Task 9: complete (27346e7)
Task 10: implemented 1d7102f + 5bcde4b (impl a4e2f873c1b277184); REAL SANDBOX GREEN twice (197s/194s). Product fix: payout_paypal_id receiver (sandbox emails unconfirmed → UNCLAIMED). Review dispatched (sonnet).
Ruling U: add Task 10b (opus) before T11: (a) cap retries for payout.cancel_item (and generally: failed_retryable older than 24h or >20 attempts → failed_terminal + anomaly), list long-retrying cancels/ops as anomalies; (b) journal PayPal fees: capture seller_receivable_breakdown.paypal_fee and payout batch fees → Dr paypal_fees_expense / Cr cash_paypal, so cash_paypal tracks the real balance — cost: one more task.
Task 10b: dispatched (opus), BASE 5bcde4b
Task 10: review Approved (minor: curl example for payout_paypal_id → fold into T11)
Task 10: complete (1d7102f, 5bcde4b)
Task 10b: implemented 4785974. Round 2 sent with rulings:
Ruling V: retry cap applies only to order.create; capture/payout.send/cancel keep retrying (unknown outcome = money may have moved) + operation_retrying anomaly.
Ruling W: per-world opening bank capital Dr cash_paypal / Cr bank_equity, BANK_SEED_CAPITAL_CENTS default 10000, key bank_capital:seed:<worldId> — fees must not make last note holder unredeemable.
Task 10b: round 2 a983b10; review dispatched (opus)
Task 11: dispatched (opus) in parallel, BASE a983b10
Task 10b: review (opus) Needs fixes — I1 capped note-buy order.create → confirm_checkout PENDING forever; I2 fee scans oldest-200 + no exclusion of journaled fees. Minors: indexes (partial status, kind/status/created_at), dup anomalies, seed simAt, env validation, capture-fee late path, zero-fee provisional.
Fix round DEFERRED until Task 11 implementer finishes (shared worktree; avoid concurrent writers).
Task 11: implemented d9ea554 (impl ae14d30b1842e7f96); LOCAL AGENT RUNS 2/2 PASS (~195s, ~$1/run). Review dispatched (sonnet).
Task 10b: fix round 3 sent (resume impl), in parallel with T11 review.
Task 11: review Approved (the src edits were dispatch-authorized UX fixes; no --dangerously-skip-permissions used — reviewer confirmed by grep)
Task 11: complete (d9ea554). Prod 3/3 run → Task 12.
Task 10b: fix round 3 608301f; re-review dispatched (sonnet)
Task 10b: re-review all addressed
Task 10b: complete (4785974, a983b10, 608301f)
Final review: dispatched (opus) over dbee367..608301f
Final review: With fixes — I1 no real-PG concurrency; I2 Neon pool lifecycle; I3 checkout return 404s; minors. One fix dispatch (opus) per final-fix.md. Ruling X: bank seed capital is lendable by design (M6 accepted).
Final fixes: 608301f..2b9868e (11 commits); test 473, test:pg 483, build ok; prod census: only 0000-0001 applied, prod tables nearly empty. Re-review dispatched (sonnet).
Final fixes: re-review all addressed. Prod migration BLOCKED by permission classifier — asked user to run drizzle-kit migrate. Deploy held.
