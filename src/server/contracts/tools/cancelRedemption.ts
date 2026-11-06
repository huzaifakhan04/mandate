import { z } from "zod";

import { fail, ok } from "../envelope";
import { defineTool } from "../registry";
import { cancelQueuedRedemption } from "../../services/notes";

const inputSchema = z.object({
  note_tx_id: z.uuid(),
});

const outputSchema = z.object({ note_tx_id: z.string(), status: z.string(), amount_cents: z.number() });

/** P5 Task 3: withdraws one of the agent's own QUEUED redemptions (from redeem_notes). */
export const cancelRedemptionTool = defineTool({
  name: "cancel_redemption",
  title: "Cancel Redemption",
  description:
    "Cancels one of the calling agent's QUEUED note redemptions (redeem_notes returns QUEUED with " +
    "note_tx_id when the bank's reserve floor gates a payout). The units are yours again at once; " +
    "nothing was paid. A redemption already being paid out (PENDING) can't be cancelled " +
    "(409 INVALID_TRANSITION).",
  auth: "agent",
  mutating: true,
  readOnly: false,
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("cancel_redemption requires an authenticated agent");
    }

    const result = await cancelQueuedRedemption(ctx.tx, ctx.worldId, ctx.agentId, input.note_tx_id);

    switch (result.outcome) {
      case "not_found": {
        // M1 (final review): point back at get_status rather than leaving a dead end.
        const envelope = fail("NOT_FOUND", "No such redemption.", ["redemption_not_found"]);
        envelope.next_actions = [{ tool: "get_status", args: {} }];
        return envelope;
      }
      case "not_queued":
        return fail(
          "INVALID_TRANSITION",
          `This redemption is ${result.status.toUpperCase()}, not QUEUED; only a queued redemption can be cancelled.`,
          ["invalid_transition"],
          { redemption_status: result.status.toUpperCase() },
        );
      case "cancelled":
        return ok(
          { note_tx_id: input.note_tx_id, status: "CANCELLED", amount_cents: Number(result.amountCents) },
          {
            status: "CANCELLED",
            summary: `Queued redemption of ${result.amountCents.toString()} cents cancelled; those note units are yours again.`,
            next_actions: [{ tool: "get_status", args: {} }],
          },
        );
    }
  },
});
