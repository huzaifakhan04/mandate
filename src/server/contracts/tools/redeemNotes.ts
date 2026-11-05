import { z } from "zod";

import { fail, ok } from "../envelope";
import { defineTool } from "../registry";
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
    "balance (position minus any other redemption still settling), INSUFFICIENT_LIQUIDITY " +
    "if the bank doesn't currently have the cash available, or PAYOUT_RECEIVER_MISSING if " +
    "the agent has no payout receiver on file.",
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
    if (outcome.outcome === "insufficient_liquidity") {
      return fail(
        "INSUFFICIENT_LIQUIDITY",
        "The bank doesn't have enough available liquidity for this redemption right now.",
        ["insufficient_liquidity"],
        { available_liquidity_cents: Number(outcome.availableLiquidityCents) },
      );
    }
    if (outcome.outcome === "payout_receiver_missing") {
      return fail(
        "PAYOUT_RECEIVER_MISSING",
        "This agent has no payout receiver on file.",
        ["payout_receiver_missing"],
      );
    }

    const { noteTxId, payoutOperationId } = outcome;
    ctx.afterCommit(async () => {
      try {
        await applyRedemptionPayoutOutcome(ctx.db, payoutOperationId);
      } catch (err) {
        console.error(`[redeem_notes] applyRedemptionPayoutOutcome failed for ${payoutOperationId}:`, err);
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
