import type { Db } from "../db/client";
import { paypalOperations } from "../db/schema";
import { scoped } from "../db/scoped";
import { trialBalance } from "../ledger/trialBalance";

/**
 * Task 10 — the report behind the test-only `GET /api/test/ledger`
 * (served only with `MANDATE_TEST_ENDPOINTS=1`; see the route): a world's
 * trial balance and its `paypal_operations`, so a real-sandbox end-to-end
 * test can assert ledger and operation invariants against a server that
 * owns its own in-memory database. Carries no secrets: operation rows are
 * reduced to kind / purpose / status / PayPal id.
 */
export interface TestLedgerReport {
  world_id: string;
  trial_balance_cents: string;
  /** Accounts with a non-zero balance (code, owner, cents as a decimal string). */
  accounts: { code: string; owner_ref: string | null; balance_cents: string }[];
  operations: {
    total: number;
    /** Rows whose status starts with `failed_` (`failed_retryable` / `failed_terminal`). */
    failed: number;
    by_status: Record<string, number>;
    rows: { kind: string; purpose: string | null; status: string; paypal_id: string | null; attempts: number }[];
  };
}

export async function testLedgerReport(db: Db, worldId: string): Promise<TestLedgerReport> {
  const balance = await trialBalance(db, worldId);
  const ops = await scoped(db, worldId).select(paypalOperations);
  const byStatus: Record<string, number> = {};
  for (const op of ops) {
    byStatus[op.status] = (byStatus[op.status] ?? 0) + 1;
  }
  const ordered = [...ops].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return {
    world_id: worldId,
    trial_balance_cents: balance.totalCents.toString(),
    accounts: balance.accounts
      .filter((account) => account.balanceCents !== 0n)
      .map((account) => ({
        code: account.code,
        owner_ref: account.ownerRef,
        balance_cents: account.balanceCents.toString(),
      })),
    operations: {
      total: ops.length,
      failed: ops.filter((op) => op.status.startsWith("failed_")).length,
      by_status: byStatus,
      rows: ordered.map((op) => ({
        kind: op.kind,
        purpose: op.purpose,
        status: op.status,
        paypal_id: op.paypalId,
        attempts: op.attempts,
      })),
    },
  };
}
