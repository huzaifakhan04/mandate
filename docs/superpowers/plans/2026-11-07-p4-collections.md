# P4 Clock & Collections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Consequences over time. On the simulated bank clock, a loan that isn't repaid moves down a delinquency ladder:
1. late fees and a rate penalty;
2. notices to the agent and the owner;
3. score drops and a frozen limit;
4. charge-off with an allowance;
5. the principal's guarantee invoked (a PayPal payment link to the human owner);
6. recovery.

Good behaviour grows limits. A vault auto-debit is attempted, with a documented fallback.

**Architecture:**
- `processDue(db, worldId, simNow)` runs from the tick cron for every active world, and synchronously after a manual clock advance.
- Every ladder step is idempotent, keyed by `(loan_id, step)`, and posts its journal inside one transaction under the series → loan lock order.
- Notices are rows in `events` plus `agent_notices` (shown to agents via `get_status` / `get_loan`, and in the owner dashboard).
- The vault attempt uses PayPal Vault v3, payment-method token (spike: setup-token 201). Any failure falls back to a fresh repayment link for the owner.

**Spec:** `docs/superpowers/specs/2026-11-05-mandate-design.md` (P4 row; loan state machine LATE → SUBSTANDARD → CHARGED_OFF → RECOVERED; consequences). Rulings: P1 (`docs/superpowers/plans/p1-rulings.md`), P2 and P3 ledgers.

## Global Constraints
- **All earlier rules apply.** Money is in integer cents. No PayPal or OpenAI call inside a transaction. Lock order is series → loan → positions. Main world = PayPal, private worlds = sim. The commit trailer is `Co-Authored-By` only.
- **Ladder** (sim days after `due_sim_at`, for a loan that is ACTIVE with outstanding > 0):

  | Day | Step | Action |
  |---|---|---|
  | +1 | `late` | Status `late`. Late fee = min(500, max(100, 5% × outstanding principal)) cents, added to `late_fee_outstanding`. Notice to the agent and the owner. Score history entry −15 (the scorecard already derives late). |
  | +3 | `penalty` | A rate penalty adds fee = ceil(outstanding principal × 200 bps × days_late ÷ 365), recomputed on cure only up to the cure date. Notice. |
  | +7 | `substandard` | Status `substandard`. The agent is restricted: status `restricted`. A restricted agent can't borrow but can still repay (P2 M4). The mandate is frozen for new loans across all of the principal's agents in the world. Notice to the owner. |
  | +10 | `charged_off` | Status `charged_off`. Journal: Dr `provision_expense` / Cr `allowance_for_losses` for outstanding principal, then Dr `allowance_for_losses` / Cr `loans_receivable`. Fees receivable are reversed, Dr `fee_income` / Cr `fees_receivable`, whatever applies to how fees were booked; reconcile with the existing P1 accounts. Note holders bear the loss pro rata: Dr `notes_payable[holder]` / Cr `provision_expense` share, using the distribution helper. **Guarantee:** a PayPal checkout link to the principal for the outstanding amount, purpose `guarantee`. Main world: on PayPal. Private: sim, approved via the dashboard sim-approve route. |
  | (any) | `recovered` | A payment after charge-off: Dr cash / Cr `recoveries_income` (new account), and holders are credited back pro rata up to their loss, Dr `recoveries_income` / Cr `notes_payable[holder]`. Status `recovered`. |

- **Cure:** any repayment covering everything outstanding before charge-off returns the loan to `repaid`. The agent goes back to `active` once it has no substandard loans.
- **Waterfall order** (updates P1): late fees → penalty/fee → principal → remainder.
- **Limit growth:** after N on-time repaid loans, the score history drives the grade (P3). No extra mechanism is needed beyond the scorecard. The dashboard shows a "limit increased" event when the grade improves.
- **Vault:**
  - The owner can save a PayPal payment method from the dashboard: a setup-token, approve, then a payment token, stored on the principal.
  - On day +1 and day +7, if a vault token exists, try one capture (purpose `vault_debit`) for the outstanding amount.
  - Any failure (sandbox refusal, decline) records `vault_failed` and falls back to sending the guarantee or repayment link.
  - If the sandbox doesn't support vaulted capture without the buyer present, document it and keep the fallback as the path. Verify on real sandbox once.
- **Notices:** `agent_notices` (world_id, agent_id, principal_id, kind, loan_id, sim_at, body, read_at). `get_status` includes unread notices. The dashboard has a notices list.
- **Clock:** private worlds already have +1/+7. The main world clock stays real-time-anchored. The ladder uses sim days, so it doesn't advance on its own in the main world, where speed is 0 — **Ruling P4-A:** the main world gets `speed=1` so due dates pass in real time for demos (1 sim day = 1 real day). Judges see consequences in private worlds via +1/+7.

## Review Focus
1. **The ladder runs twice.** Concurrent tick plus manual advance, or a crash mid-step, must give each step exactly once (unique `(loan_id, step)` journal keys plus a conditional status update).
2. **A partial repayment during the ladder:** the waterfall order and the cure rules hold, and the trial balance stays 0.
3. **Charge-off with several note holders:** the loss is shared pro rata, Σ = principal, and `notes_payable == units` (Ruling T) still holds.
4. **The guarantee is paid twice, or after recovery:** the excess is refunded (the remainder path) and nothing is double-credited.
5. **A vault capture on a PayPal outage:** it is never captured twice. Derived op ids, as for other captures.

### Task 1: Ladder engine, late fees, penalty, notices (+ waterfall update)
### Task 2: Charge-off, holder loss sharing, guarantee link, recovery, cure
### Task 3: Vault save + debit attempt + fallback; sandbox verification
### Task 4: Dashboard + docs + harness scenario (private world: borrow → +7 → late notices → +7 → charge-off → owner pays guarantee → recovered); deploy
