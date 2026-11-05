import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "../db/client";
import { ledgerAccounts } from "../db/schema";
import { scoped } from "../db/scoped";

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
  "provision_expense",
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
  provision_expense: "expense",
  bank_equity: "equity",
  suspense: "asset",
} as const;

type LedgerAccountRow = typeof ledgerAccounts.$inferSelect;

/**
 * Creates the top-level (owner_ref = null) chart-of-accounts rows for a
 * world, skipping any that already exist. Idempotent: calling it twice
 * for the same world never creates duplicate rows, even though the
 * underlying unique index treats distinct NULLs as non-conflicting (we
 * query-then-insert rather than relying on an ON CONFLICT DO NOTHING
 * against that index).
 */
export async function ensureChartOfAccounts(
  db: Db,
  worldId: string,
): Promise<void> {
  const existing = await scoped(db, worldId).select(ledgerAccounts);
  const existingCodes = new Set(
    existing.filter((row) => row.ownerRef === null).map((row) => row.code),
  );

  const missing = ACCOUNT_CODES.filter((code) => !existingCodes.has(code));
  if (missing.length === 0) {
    return;
  }

  for (const code of missing) {
    await scoped(db, worldId).insert(ledgerAccounts, {
      code,
      type: CHART_OF_ACCOUNTS[code],
      ownerRef: null,
    });
  }
}

/**
 * Returns the ledger account for `(worldId, code, ownerRef)`, creating it
 * on demand if it doesn't exist yet. Must be called with a transactional
 * `db` (e.g. the `tx` passed into `db.transaction(...)`) so the
 * select-then-insert is atomic with the rest of the journal post.
 */
export async function getOrCreateAccount(
  db: Db,
  worldId: string,
  code: AccountCode,
  ownerRef: string | null,
): Promise<LedgerAccountRow> {
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

  if (found) {
    return found;
  }

  const [created] = await scoped(db, worldId).insert(ledgerAccounts, {
    code,
    type: CHART_OF_ACCOUNTS[code],
    ownerRef,
  });

  if (!created) {
    throw new Error(
      `Failed to create ledger account ${code}/${ownerRef ?? "null"}`,
    );
  }

  return created;
}
