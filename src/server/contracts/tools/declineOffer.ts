import { z } from "zod";

import { fail, ok } from "../envelope";
import { defineTool } from "../registry";
import { declineOffer } from "../../services/loans";

const inputSchema = z.object({
  offer_id: z.uuid(),
});

const outputSchema = z.object({ offer_id: z.string(), status: z.string() });

export const declineOfferTool = defineTool({
  name: "decline_offer",
  title: "Decline Offer",
  description:
    "Declines one of the calling agent's open loan offers (from apply_for_loan), so it can no " +
    "longer be accepted. Nothing is charged. Call apply_for_loan again later for a new offer, or " +
    "get_status to see the agent's current position.",
  auth: "agent",
  mutating: true,
  readOnly: false,
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("decline_offer requires an authenticated agent");
    }

    const result = await declineOffer(ctx.tx, ctx.worldId, ctx.agentId, input.offer_id);

    switch (result.outcome) {
      case "not_found":
        return fail("NOT_FOUND", "No such offer.", ["offer_not_found"]);
      case "offer_expired":
        return fail("OFFER_EXPIRED", "This offer has expired.", ["offer_expired"]);
      case "invalid_transition":
        return fail("INVALID_TRANSITION", `This offer is ${result.state}, not OFFERED.`, ["invalid_transition"], {
          offer_status: result.state,
        });
      case "declined":
        return ok(
          { offer_id: input.offer_id, status: "DECLINED_BY_AGENT" },
          {
            status: "DECLINED_BY_AGENT",
            summary: "Offer declined.",
            next_actions: [{ tool: "get_status", args: {} }],
          },
        );
    }
  },
});
