import { z } from "zod";

import { fail, ok } from "../envelope";
import { defineTool } from "../registry";
import {
  beginConfirmCheckout,
  finalizeAwaitingCreate,
  finalizeConfirmCheckout,
  type BeginConfirmCheckoutOutcome,
} from "../../services/checkouts";

const inputSchema = z.object({
  checkout_id: z.string().min(1),
});

const outputSchema = z.object({}).passthrough();

export const confirmCheckoutTool = defineTool({
  name: "confirm_checkout",
  title: "Confirm Checkout",
  description:
    "Captures a PayPal checkout once the human has approved it, and applies its " +
    "effect (crediting notes, settling a repayment, …) exactly once. Call it again " +
    "if it comes back AWAITING_APPROVAL or PENDING.",
  auth: "agent",
  mutating: true,
  readOnly: false,
  // Ruling L: naturally idempotent by `checkout_id` already (the capture
  // operation's id is deterministically derived from it, and every
  // domain effect is keyed/guarded for exactly-once application) —
  // storing an in-progress status like AWAITING_APPROVAL under an
  // Idempotency-Key would freeze a caller's polling loop on that stale
  // snapshot forever. `runTool` ignores any idempotency key for this tool.
  idempotent: false,
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("confirm_checkout requires an authenticated agent");
    }

    const begin = await beginConfirmCheckout(ctx.tx, ctx.worldId, ctx.agentId, input.checkout_id);
    if (begin.outcome === "not_found") {
      return fail("NOT_FOUND", "No checkout found for this agent with that id.", ["checkout_not_found"]);
    }

    ctx.setFinalizeState(begin);
    // Fix round 1 (I2a): a clean, safe fallback — the caller can always
    // retry with the same checkout_id even if finalize never runs.
    return ok(
      { checkout_id: input.checkout_id },
      {
        status: "PENDING",
        summary: "Processing the checkout.",
        next_actions: [{ tool: "confirm_checkout", args: { checkout_id: input.checkout_id } }],
      },
    );
  },
  finalize: async (envelope, ctx, state) => {
    const pending = state as BeginConfirmCheckoutOutcome | undefined;
    if (!pending || pending.outcome === "not_found") {
      return envelope;
    }

    if (pending.outcome === "awaiting_create") {
      const result = await finalizeAwaitingCreate(ctx.db, pending.createOperationId);
      return ok(result.data, {
        status: result.status,
        summary: result.summary,
        reason_codes: result.reasonCodes,
        next_actions: result.approveUrl
          ? [
              {
                tool: "human_approval",
                args: {
                  url: result.approveUrl,
                  who: "payer",
                  then: { tool: "confirm_checkout", args: { checkout_id: result.checkoutId } },
                },
              },
            ]
          : [{ tool: "confirm_checkout", args: { checkout_id: pending.createSourceId } }],
      });
    }

    const result = await finalizeConfirmCheckout(ctx.db, ctx.worldId, ctx.simNow, {
      checkoutPurpose: pending.checkoutPurpose,
      createSourceId: pending.createSourceId,
      orderId: pending.orderId,
      rail: pending.rail,
    });

    const nextActions =
      result.status === "AWAITING_APPROVAL"
        ? [
            {
              tool: "human_approval",
              args: {
                url: result.approveUrl,
                who: "payer",
                then: { tool: "confirm_checkout", args: { checkout_id: result.checkoutId ?? pending.orderId } },
              },
            },
          ]
        : result.status === "PENDING"
          ? [{ tool: "confirm_checkout", args: { checkout_id: pending.orderId } }]
          : result.status === "CHECKOUT_FAILED" && result.nextAction
            ? // Fix round 1 (I3) / Fix round 2 (item 4): a failed checkout
              // can't be retried under the same id — the handler's own
              // `retryNextAction` says where to start over, with the
              // original amount already filled in.
              [result.nextAction]
            : [];

    return ok(result.data, {
      status: result.status,
      summary: result.summary,
      reason_codes: result.reasonCodes,
      next_actions: nextActions,
    });
  },
});
