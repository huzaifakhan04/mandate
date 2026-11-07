import { z } from "zod";

import { ok } from "../envelope";
import { defineTool } from "../registry";
import { checkoutLimits } from "../rateLimits";
import { createNotePurchase, NOTES_DISCLOSURE } from "../../services/notes";
import { executeOperation, successBody } from "../../paypal/operations";

const inputSchema = z.object({
  amount_cents: z.number().int().min(1000).max(100000),
});

const outputSchema = z.object({
  checkout_id: z.string(),
  approve_url: z.string().optional(),
  amount_cents: z.number(),
  disclosure: z.string(),
});

/**
 * Fix round 1 (I2b): bookkeeping passed from `handler` to `finalize` via
 * `ctx.setFinalizeState`, never through the envelope `handler` returns —
 * that envelope is a clean, public, safely-replayable fallback on its
 * own (Fix round 1, I2a/I2c).
 */
interface BuyNotesFinalizeState {
  noteTxId: string;
  createOperationId: string;
  amountCents: string;
}

export const buyNotesTool = defineTool({
  name: "buy_notes",
  title: "Buy Notes",
  description:
    "Buys lender notes in Mandate Pool A, funded by a PayPal checkout the agent's " +
    "human must approve. Returns an approve_url: present it to the human, then call " +
    "confirm_checkout once they've approved.",
  auth: "agent",
  mutating: true,
  readOnly: false,
  rateLimits: checkoutLimits("buy_notes"),
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("buy_notes requires an authenticated agent");
    }

    const amountCents = BigInt(input.amount_cents);
    const created = await createNotePurchase(ctx.tx, ctx.worldId, ctx.agentId, amountCents);

    ctx.setFinalizeState({
      noteTxId: created.noteTxId,
      createOperationId: created.createOperationId,
      amountCents: amountCents.toString(),
    } satisfies BuyNotesFinalizeState);

    // Fix round 1 (I2a/I2d): a clean, safe, immediately-usable fallback —
    // no internal fields, and `checkout_id` is set to the note
    // transaction's own id so `confirm_checkout` has something to act on
    // even if `finalize` never runs (e.g. it throws). `confirm_checkout`
    // accepts this id interchangeably with the real PayPal/sim order id
    // once one exists (`beginConfirmCheckout`'s source-id fallback).
    return ok(
      { checkout_id: created.noteTxId, amount_cents: Number(amountCents), disclosure: NOTES_DISCLOSURE },
      {
        status: "PENDING",
        summary: "Creating the checkout.",
        next_actions: [{ tool: "confirm_checkout", args: { checkout_id: created.noteTxId } }],
      },
    );
  },
  finalize: async (envelope, ctx, state) => {
    const pending = state as BuyNotesFinalizeState | undefined;
    if (!pending) {
      // The handler didn't get far enough to call setFinalizeState (e.g.
      // it threw before returning) — nothing to finalize.
      return envelope;
    }

    const result = await executeOperation(ctx.db, pending.createOperationId, { ignoreBackoff: true });

    if (result.status === "succeeded") {
      const body = successBody(result, "order.create");
      return ok(
        {
          checkout_id: body.orderId,
          approve_url: body.approveUrl,
          amount_cents: Number(BigInt(pending.amountCents)),
          disclosure: NOTES_DISCLOSURE,
        },
        {
          status: "AWAITING_APPROVAL",
          summary: "Checkout created. Have the payer approve it, then confirm.",
          next_actions: [
            {
              tool: "human_approval",
              args: {
                url: body.approveUrl,
                who: "payer",
                then: { tool: "confirm_checkout", args: { checkout_id: body.orderId } },
              },
            },
          ],
        },
      );
    }

    // Still pending/failed-to-execute: the same fallback shape `handler`
    // already returned, so storing/returning this changes nothing a
    // caller couldn't already see.
    return ok(
      { checkout_id: pending.noteTxId, amount_cents: Number(BigInt(pending.amountCents)), disclosure: NOTES_DISCLOSURE },
      {
        status: "PENDING",
        summary: "Checkout creation is still pending; retry shortly.",
        next_actions: [{ tool: "confirm_checkout", args: { checkout_id: pending.noteTxId } }],
      },
    );
  },
});
