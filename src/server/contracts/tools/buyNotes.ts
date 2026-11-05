import { z } from "zod";

import { ok } from "../envelope";
import { defineTool } from "../registry";
import { createNotePurchase, NOTES_DISCLOSURE } from "../../services/notes";
import { executeOperation, successBody } from "../../paypal/operations";

const inputSchema = z.object({
  amount_cents: z.number().int().min(1000).max(100000),
});

const outputSchema = z.object({
  checkout_id: z.string().optional(),
  approve_url: z.string().optional(),
  amount_cents: z.number(),
  disclosure: z.string(),
  note_tx_id: z.string().optional(),
});

/** Internal bookkeeping stashed in the handler's envelope for `finalize` to pick up (never shown to the caller — `finalize` always replaces this envelope). */
interface PendingBuyNotes {
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
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("buy_notes requires an authenticated agent");
    }

    const amountCents = BigInt(input.amount_cents);
    const created = await createNotePurchase(ctx.tx, ctx.worldId, ctx.agentId, amountCents);

    const pending: PendingBuyNotes = {
      noteTxId: created.noteTxId,
      createOperationId: created.createOperationId,
      amountCents: amountCents.toString(),
    };

    return ok(
      { note_tx_id: created.noteTxId, amount_cents: Number(amountCents), disclosure: NOTES_DISCLOSURE, _pending: pending },
      { status: "PENDING", summary: "Creating the checkout." },
    );
  },
  finalize: async (envelope, ctx) => {
    const pending = (envelope.data as Record<string, unknown> | undefined)?._pending as
      | PendingBuyNotes
      | undefined;
    if (!pending) {
      // The handler didn't get far enough to enqueue a checkout (e.g. it
      // threw before returning) — nothing to finalize.
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

    return ok(
      {
        note_tx_id: pending.noteTxId,
        amount_cents: Number(BigInt(pending.amountCents)),
        disclosure: NOTES_DISCLOSURE,
      },
      {
        status: "PENDING",
        summary: "Checkout creation is still pending; retry shortly.",
        next_actions: [{ tool: "confirm_checkout", args: { checkout_id: pending.noteTxId } }],
      },
    );
  },
});
