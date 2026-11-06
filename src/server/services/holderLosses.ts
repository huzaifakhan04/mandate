import { and, eq, gt } from "drizzle-orm";

import type { Db } from "../db/client";
import { events, loanHolderLosses, loans, notePositions, noteTransactions } from "../db/schema";
import { scoped } from "../db/scoped";
import { postJournal } from "../ledger/postJournal";

/**
 * Ruling P4-D — deferred holder losses. At charge-off a holder's share of
 * the principal loss is computed on its FULL units, but units reserved by
 * its own pending redemptions can't be cut (the payout may already be on
 * its way). That part is `loan_holder_losses.deferred_cents`, settled here
 * when one of the holder's redemptions settles, inside the redemption
 * settlement's transaction (series → position locked; it runs only after
 * that transaction's conditional `pending → completed|failed` update won,
 * so it runs once per redemption):
 *
 * - FAILED: the reserved units are the holder's again, so the deferred
 *   loss is applied, oldest first, up to the units no longer reserved by
 *   its remaining pending redemptions: Dr `notes_payable[holder]` / Cr
 *   `provision_expense`, units −= a, `loss_cents` += a. If the loan has
 *   already recovered money the bank kept (recovered − Σ credited back to
 *   holders), up to `a` of it is passed straight back (holders first, as
 *   at recovery): Dr `recoveries_income` / Cr `notes_payable[holder]`,
 *   units += b, `recovered_cents` += b.
 * - Either outcome: the holder's deferred total is capped at its remaining
 *   pending redemptions. What no longer fits (a SUCCEEDED redemption paid
 *   those units out in full) is absorbed by the bank's capital: the
 *   provision for it was already booked at charge-off, so nothing more is
 *   journaled — `deferred_cents` just drops.
 *
 * Reads of `loans.recovered_cents` / `loan_holder_losses` are consistent
 * here without the loan row lock: every writer of them (charge-off,
 * recovery) holds the note series lock, which this caller holds too.
 */
export async function settleDeferredHolderLosses(
  tx: Db,
  worldId: string,
  args: {
    positionId: string;
    agentId: string;
    redemptionId: string;
    outcome: "completed" | "failed";
    simAt: Date;
  },
): Promise<void> {
  const rows = (
    await scoped(tx, worldId).select(
      loanHolderLosses,
      and(eq(loanHolderLosses.agentId, args.agentId), gt(loanHolderLosses.deferredCents, 0n))!,
    )
  ).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
  if (rows.length === 0) {
    return;
  }
  const [position] = await scoped(tx, worldId).select(notePositions, eq(notePositions.id, args.positionId));
  if (!position) {
    return;
  }
  const stillPending = await scoped(tx, worldId).select(
    noteTransactions,
    and(
      eq(noteTransactions.positionId, position.id),
      eq(noteTransactions.kind, "redeem"),
      eq(noteTransactions.status, "pending"),
    )!,
  );
  const pendingCents = stillPending.reduce((sum, row) => sum + row.amountCents, 0n);

  let units = position.units;
  let applyLeft = args.outcome === "failed" ? units - pendingCents : 0n;
  let capLeft = pendingCents;
  for (const row of rows) {
    let deferred = row.deferredCents;
    let loss = row.lossCents;
    let recovered = row.recoveredCents;
    const applied = applyLeft > 0n ? (deferred < applyLeft ? deferred : applyLeft) : 0n;
    if (applied > 0n) {
      applyLeft -= applied;
      deferred -= applied;
      loss += applied;
      units -= applied;
      await postJournal(tx, {
        worldId,
        memo: "Deferred share of a charged-off loan's loss (redemption failed)",
        sourceType: "loan_holder_losses",
        sourceId: row.id,
        simAt: args.simAt,
        idempotencyKey: `deferred_loss:${row.id}:${args.redemptionId}`,
        postings: [
          { accountCode: "notes_payable", ownerRef: args.agentId, amountCents: applied },
          { accountCode: "provision_expense", amountCents: -applied },
        ],
      });
      // Holders first: pass back what the bank already recovered and kept.
      const [loan] = await scoped(tx, worldId).select(loans, eq(loans.id, row.loanId));
      const loanRows = await scoped(tx, worldId).select(loanHolderLosses, eq(loanHolderLosses.loanId, row.loanId));
      const credited = loanRows.reduce((sum, other) => sum + other.recoveredCents, 0n);
      const retained = (loan?.recoveredCents ?? 0n) - credited;
      const back = retained > 0n ? (retained < applied ? retained : applied) : 0n;
      if (back > 0n) {
        recovered += back;
        units += back;
        await postJournal(tx, {
          worldId,
          memo: "Recovery credited back to a note holder (deferred loss)",
          sourceType: "loan_holder_losses",
          sourceId: row.id,
          simAt: args.simAt,
          idempotencyKey: `deferred_loss:${row.id}:${args.redemptionId}:recovery`,
          postings: [
            { accountCode: "recoveries_income", amountCents: back },
            { accountCode: "notes_payable", ownerRef: args.agentId, amountCents: -back },
          ],
        });
      }
    }
    const kept = deferred < capLeft ? deferred : capLeft;
    capLeft -= kept;
    const absorbed = deferred - kept;
    if (applied > 0n || absorbed > 0n) {
      await scoped(tx, worldId).update(
        loanHolderLosses,
        { lossCents: loss, recoveredCents: recovered, deferredCents: kept },
        eq(loanHolderLosses.id, row.id),
      );
      await scoped(tx, worldId).insert(events, {
        type: "loan.holder_loss_settled",
        aggregateType: "loan",
        aggregateId: row.loanId,
        payload: {
          holder_agent_id: args.agentId,
          redemption_id: args.redemptionId,
          outcome: args.outcome,
          applied_cents: Number(applied),
          absorbed_by_bank_cents: Number(absorbed),
          still_deferred_cents: Number(kept),
        },
        occurredSimAt: args.simAt,
      });
    }
  }
  if (units !== position.units) {
    await scoped(tx, worldId).update(notePositions, { units }, eq(notePositions.id, position.id));
  }
}
