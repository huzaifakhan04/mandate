import { z } from "zod";

import { fail, ok } from "../envelope";
import { defineTool } from "../registry";
import { describeError } from "../../db/errors";
import { applyRedemptionPayoutOutcome, beginNoteRedemption } from "../../services/notes";

const inputSchema = z.object({
  amount_cents: z.number().int().min(1),
});

const outputSchema = z.object({}).passthrough();

export const redeemNotesTool = defineTool({
  name: "redeem_notes",
  title: "Redeem Notes",
  description:
    "Redeems lender notes for cash, paid out to the agent's PayPal payout receiver. " +
    "Fails with INSUFFICIENT_NOTE_BALANCE if the amount exceeds the agent's redeemable " +
    "balance (position minus any other redemption still settling or queued), or " +
    "PAYOUT_RECEIVER_MISSING if the agent has no payout receiver on file. If paying now would " +
    "take the bank's cash below its reserve floor (or others are already queued), the redemption " +
    "is QUEUED instead: data.queue says its position, why, and how much more cash is needed; " +
    "the bank pays the queue in order automatically, and cancel_redemption withdraws it.",
  auth: "agent",
  mutating: true,
  readOnly: false,
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("redeem_notes requires an authenticated agent");
    }

    const amountCents = BigInt(input.amount_cents);
    const outcome = await beginNoteRedemption(ctx.tx, ctx.worldId, ctx.agentId, amountCents);

    if (outcome.outcome === "insufficient_note_balance") {
      return fail(
        "INSUFFICIENT_NOTE_BALANCE",
        "The requested amount exceeds your redeemable note balance.",
        ["insufficient_note_balance"],
        { redeemable_units: Number(outcome.redeemableUnits) },
      );
    }
    if (outcome.outcome === "payout_receiver_missing") {
      return fail(
        "PAYOUT_RECEIVER_MISSING",
        "This agent has no payout receiver on file.",
        ["payout_receiver_missing"],
      );
    }

    if (outcome.outcome === "queued") {
      // P5 Task 3: the redemption gate — queued (FIFO), paid by the tick once cash allows.
      const { queue } = outcome;
      const why =
        queue.reason === "queue_ahead"
          ? `${queue.position - 1} earlier redemption(s) (${queue.aheadCents.toString()} cents) are queued ahead of it, and the bank pays the queue in order.`
          : `paying it now would take the bank's available cash (${queue.availableLiquidityCents.toString()} cents) below its reserve floor (${queue.reserveFloorCents.toString()} cents: a share of the notes it owes holders).`;
      return ok(
        {
          note_tx_id: outcome.noteTxId,
          amount_cents: Number(amountCents),
          queue: {
            position: queue.position,
            ahead_cents: Number(queue.aheadCents),
            reason: queue.reason,
            reserve_floor_cents: Number(queue.reserveFloorCents),
            available_liquidity_cents: Number(queue.availableLiquidityCents),
            cash_needed_cents: Number(queue.cashNeededCents),
          },
        },
        {
          status: "QUEUED",
          summary:
            `Redemption queued at position ${queue.position}: ${why} ` +
            `It is paid automatically, in order, once repayments or new note purchases bring in about ` +
            `${queue.cashNeededCents.toString()} more cents of available cash (checked every minute; ` +
            "paid FIFO as cash allows, even while this world's clock is frozen). " +
            "Your units stay reserved meanwhile; call cancel_redemption to withdraw it.",
          reason_codes: ["redemption_queued", queue.reason],
          next_actions: [
            { tool: "get_status", args: {} },
            { tool: "cancel_redemption", args: { note_tx_id: outcome.noteTxId } },
          ],
        },
      );
    }

    const { noteTxId, payoutOperationId } = outcome;
    ctx.afterCommit(async () => {
      try {
        await applyRedemptionPayoutOutcome(ctx.db, payoutOperationId);
      } catch (err) {
        console.error(`[redeem_notes] applyRedemptionPayoutOutcome failed for ${payoutOperationId}: ${describeError(err)}`);
      }
    });

    return ok(
      { note_tx_id: noteTxId, amount_cents: Number(amountCents) },
      {
        status: "PENDING",
        summary: "Redemption submitted; it will settle shortly.",
        next_actions: [{ tool: "get_status", args: {} }],
      },
    );
  },
});
