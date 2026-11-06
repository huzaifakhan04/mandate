import { inArray } from "drizzle-orm";

import type { Db } from "../db/client";
import { loans, offers } from "../db/schema";
import { scoped } from "../db/scoped";
import { ceclLoanCents, expectedLossBpsAtOffer, isCeclDelinquentStatus } from "../domain/cecl";
import { OWING_LOAN_DB_STATUSES } from "../domain/loanMachine";
import { postJournal } from "../ledger/postJournal";
import { getCodeBalance } from "../ledger/trialBalance";
import { outstandingParts } from "./collections";

/**
 * P5 Task 2 — the daily CECL-style allowance.
 *
 * Target = Σ over open owing loans (active / late / substandard; a
 * disbursing loan owes nothing yet) of `ceclLoanCents` (outstanding
 * principal × the offer's PD × LGD, ×2 when late or substandard, capped at
 * the principal; `domain/cecl.ts`). `bookCecl` posts the difference from
 * the current `allowance_for_losses` balance — Dr `provision_expense` / Cr
 * `allowance_for_losses` to build it, the reverse to release it — keyed
 * `cecl:<worldId>:<simDay>`. It runs inside `stepEconomy`'s transaction for
 * the day (the `economy_state` row and the booking commit together, under
 * the note-series lock), so each day books once.
 *
 * The allowance has no other writer than this and the P4 charge-off
 * (`collections.ts`), which runs under the same series lock and releases
 * the charged-off loan's reserve before provisioning only the shortfall —
 * so the whole allowance is the CECL reserve, and it never goes negative.
 */

export interface CeclLoanReserve {
  loanId: string;
  status: string;
  outstandingPrincipalCents: bigint;
  expectedLossBps: number;
  reserveCents: bigint;
}

export interface CeclTarget {
  targetCents: bigint;
  loans: CeclLoanReserve[];
}

/** The allowance balance (a credit on a contra-asset, returned positive). */
export async function allowanceBalance(db: Db, worldId: string): Promise<bigint> {
  return -(await getCodeBalance(db, worldId, "allowance_for_losses"));
}

/** The CECL target from the loans as they are now (read inside the caller's transaction). */
export async function ceclTarget(db: Db, worldId: string): Promise<CeclTarget> {
  const owing = await scoped(db, worldId).select(loans, inArray(loans.status, [...OWING_LOAN_DB_STATUSES]));
  owing.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const offerRows = owing.length
    ? await scoped(db, worldId).select(
        offers,
        inArray(
          offers.id,
          owing.map((loan) => loan.offerId),
        ),
      )
    : [];
  const disclosureByOffer = new Map(offerRows.map((offer) => [offer.id, offer.disclosure]));
  const reserves = owing.map((loan): CeclLoanReserve => {
    const outstandingPrincipalCents = outstandingParts(loan).principalCents;
    const expectedLossBps = expectedLossBpsAtOffer(disclosureByOffer.get(loan.offerId));
    return {
      loanId: loan.id,
      status: loan.status,
      outstandingPrincipalCents,
      expectedLossBps,
      reserveCents: ceclLoanCents({
        outstandingPrincipalCents,
        expectedLossBps,
        delinquent: isCeclDelinquentStatus(loan.status),
      }),
    };
  });
  return { targetCents: reserves.reduce((sum, row) => sum + row.reserveCents, 0n), loans: reserves };
}

export interface CeclBooking {
  targetCents: bigint;
  /** The allowance before the booking. */
  previousCents: bigint;
  /** target − previous: > 0 built (provision), < 0 released. */
  deltaCents: bigint;
}

/**
 * Books the day's CECL delta. The caller holds the note-series lock in a
 * transaction (`stepEconomy`). Posts nothing when the allowance already
 * equals the target.
 */
export async function bookCecl(tx: Db, worldId: string, simDay: number, simAt: Date): Promise<CeclBooking> {
  const { targetCents } = await ceclTarget(tx, worldId);
  const previousCents = await allowanceBalance(tx, worldId);
  const deltaCents = targetCents - previousCents;
  if (deltaCents !== 0n) {
    await postJournal(tx, {
      worldId,
      memo: deltaCents > 0n ? "CECL allowance: provision for expected losses" : "CECL allowance: release",
      sourceType: "economy_state",
      sourceId: worldId,
      simAt,
      idempotencyKey: `cecl:${worldId}:${simDay}`,
      postings: [
        { accountCode: "provision_expense", amountCents: deltaCents },
        { accountCode: "allowance_for_losses", amountCents: -deltaCents },
      ],
    });
  }
  return { targetCents, previousCents, deltaCents };
}
