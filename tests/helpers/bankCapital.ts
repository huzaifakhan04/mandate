import { randomUUID } from "crypto";

import type { Db } from "@/server/db/client";
import { postJournal } from "@/server/ledger/postJournal";
import { simCaptureFeeCents } from "@/server/rail/simHandler";

/**
 * Task 10b: PayPal's fees are the bank's expense, paid out of
 * `cash_paypal` — so a pool funded only by note purchases holds less cash
 * than the notes it owes, and a holder redeeming its full balance (or a
 * loan of the whole pool) would hit INSUFFICIENT_LIQUIDITY. Tests whose
 * subject isn't fees put the bank's own capital in to cover them:
 * Dr `cash_paypal` / Cr `bank_equity`.
 */
export async function addBankCapital(db: Db, worldId: string, cents: bigint): Promise<void> {
  await postJournal(db, {
    worldId,
    memo: "Test: bank capital covering PayPal fees",
    sourceType: "test",
    sourceId: randomUUID(),
    simAt: new Date(),
    idempotencyKey: `test_bank_capital:${randomUUID()}`,
    postings: [
      { accountCode: "cash_paypal", amountCents: cents },
      { accountCode: "bank_equity", amountCents: -cents },
    ],
  });
}

/** The sim rail's simulated capture fee for `amountCents` (2.9% half-up + 30¢). */
export function simCaptureFee(amountCents: number | bigint): bigint {
  return simCaptureFeeCents(BigInt(amountCents));
}

/** The sim rail's simulated fee for one SUCCESS payout item. */
export const SIM_PAYOUT_FEE = 25n;
