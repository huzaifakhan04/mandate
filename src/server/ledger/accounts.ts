import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "../db/client";
import { ledgerAccounts } from "../db/schema";

/** The fixed chart of accounts for a world's ledger. */
export const ACCOUNT_CODES = [
  "cash_paypal",
  "loans_receivable",
  "fees_receivable",
  "allowance_for_losses",
  "notes_payable",
  "payable_to_borrower",
  "fee_income",
  "late_fee_income",
  "penalty_income",
  "recoveries_income",
  "provision_expense",
  "note_interest_expense",
  "paypal_fees_expense",
  "bank_equity",
  "suspense",
] as const;

export type AccountCode = (typeof ACCOUNT_CODES)[number];

export type AccountType =
  | "asset"
  | "contra_asset"
  | "liability"
  | "income"
  | "expense"
  | "equity";

/** `code -> type` for every account in the chart. */
export const CHART_OF_ACCOUNTS: Record<AccountCode, AccountType> = {
  cash_paypal: "asset",
  loans_receivable: "asset",
  fees_receivable: "asset",
  allowance_for_losses: "contra_asset",
  notes_payable: "liability",
  payable_to_borrower: "liability",
  fee_income: "income",
  late_fee_income: "income",
  // P4 Task 1: late fees and the rate penalty are memo balances on the
  // loan until a repayment collects them (P1: fee income on collection);
  // collected late fees Cr `late_fee_income`, the penalty Cr here.
  penalty_income: "income",
  // P4 Task 2: payments on a charged-off loan (Dr `cash_paypal` / Cr here);
  // the holders' share of it is passed back to them (Dr here / Cr
  // `notes_payable[holder]`) up to the loss they bore at charge-off.
  recoveries_income: "income",
  provision_expense: "expense",
  // Task 4 (Note economics): holders' 80% share of each repayment's fee
  // is booked Dr `note_interest_expense` / Cr `notes_payable[holder_i]`.
  note_interest_expense: "expense",
  // Task 10b: PayPal's capture/payout processing fees — the bank's own
  // expense (Dr here / Cr `cash_paypal`), so cash tracks the PayPal balance.
  paypal_fees_expense: "expense",
  bank_equity: "equity",
  suspense: "asset",
} as const;

type LedgerAccountRow = typeof ledgerAccounts.$inferSelect;

/**
 * The columns of `ledger_accounts_world_code_owner_idx` (a NULLS NOT
 * DISTINCT unique constraint — see schema.ts), used as the `ON CONFLICT`
 * target below so Postgres infers the same constraint regardless of
 * whether `ownerRef` is NULL.
 */
const ACCOUNT_CONFLICT_TARGET = [
  ledgerAccounts.worldId,
  ledgerAccounts.code,
  ledgerAccounts.ownerRef,
];

/**
 * Creates the top-level (owner_ref = null) chart-of-accounts rows for a
 * world in one batched insert, skipping any that already exist.
 * Idempotent and race-safe: relies on `ON CONFLICT DO NOTHING` against
 * `ledger_accounts_world_code_owner_idx`, which (per schema.ts) is
 * declared NULLS NOT DISTINCT, so two concurrent calls for the same
 * world can race freely and still end up with exactly one row per code.
 *
 * This writes `worldId` directly (not through `scoped()`) because
 * `scoped().insert()` doesn't expose `onConflictDoNothing`; the insert
 * still only ever targets the single `worldId` passed in.
 */
export async function ensureChartOfAccounts(
  db: Db,
  worldId: string,
): Promise<void> {
  await db
    .insert(ledgerAccounts)
    .values(
      ACCOUNT_CODES.map((code) => ({
        worldId,
        code,
        type: CHART_OF_ACCOUNTS[code],
        ownerRef: null,
      })),
    )
    .onConflictDoNothing({ target: ACCOUNT_CONFLICT_TARGET });
}

/**
 * Returns the ledger account for `(worldId, code, ownerRef)`, creating it
 * on demand if it doesn't exist yet. Must be called with a transactional
 * `db` (e.g. the `tx` passed into `db.transaction(...)`) so the account
 * lookup/creation is atomic with the rest of the journal post.
 *
 * Race-safe by construction: the insert attempt always runs first and
 * relies on `ON CONFLICT DO NOTHING` against the NULLS NOT DISTINCT
 * constraint, so two concurrent first-touches of the same owner-ref
 * sub-account (e.g. `notes_payable[agentA]`) can never both succeed —
 * exactly one insert wins, and the loser falls through to the reselect
 * below and finds the winner's row.
 */
export async function getOrCreateAccount(
  db: Db,
  worldId: string,
  code: AccountCode,
  ownerRef: string | null,
): Promise<LedgerAccountRow> {
  const [created] = await db
    .insert(ledgerAccounts)
    .values({ worldId, code, type: CHART_OF_ACCOUNTS[code], ownerRef })
    .onConflictDoNothing({ target: ACCOUNT_CONFLICT_TARGET })
    .returning();

  if (created) {
    return created;
  }

  const ownerCondition =
    ownerRef === null
      ? isNull(ledgerAccounts.ownerRef)
      : eq(ledgerAccounts.ownerRef, ownerRef);

  const [found] = await db
    .select()
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.worldId, worldId),
        eq(ledgerAccounts.code, code),
        ownerCondition,
      ),
    )
    .limit(1);

  if (!found) {
    throw new Error(
      `Expected an existing ledger account for ${code}/${ownerRef ?? "null"} after an ON CONFLICT DO NOTHING insert, found none`,
    );
  }

  return found;
}
