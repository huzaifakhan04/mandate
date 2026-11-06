import { z } from "zod";

import { ok } from "../envelope";
import { claimNextAction } from "../kyaActions";
import { defineTool } from "../registry";
import { SAMPLE_BUY_NOTES_ARGS } from "../sampleArgs";
import { registerAgent as registerAgentService } from "../../services/agents";

const inputSchema = z
  .object({
    name: z.string().min(2).max(60),
    operator: z.string().optional(),
    model: z.string().optional(),
    payout_email: z
      .string()
      .email()
      .optional()
      .describe("The PayPal account (by email) that receives loans and redemptions. Give this or payout_paypal_id."),
    payout_paypal_id: z
      .string()
      .regex(/^[A-Z0-9]{13}$/, "a PayPal payer ID is 13 uppercase letters/digits")
      .optional()
      .describe(
        "The PayPal account (by payer ID) that receives loans and redemptions, instead of payout_email — " +
          "use it when that account's email is unconfirmed (payouts to an unconfirmed email go UNCLAIMED).",
      ),
  })
  .refine((input) => !input.payout_email !== !input.payout_paypal_id, {
    message: "Give exactly one of payout_email or payout_paypal_id.",
    path: ["payout_email"],
  });

const outputSchema = z.object({
  agent_id: z.string(),
  api_key: z.string(),
  status: z.literal("ACTIVE"),
  tier: z.literal(0),
  claim_url: z.string(),
  claim_expires_at: z.string(),
  world: z.literal("main"),
  mcp: z.object({
    url: z.string(),
    header: z.string(),
  }),
});

/** `${PUBLIC_BASE_URL}/api/mcp/mcp`, falling back to `http://localhost:3000`. */
function mcpUrl(): string {
  const base = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
  return `${base.replace(/\/+$/, "")}/api/mcp/mcp`;
}

export const registerAgentTool = defineTool({
  name: "register_agent",
  title: "Register Agent",
  description:
    "Creates a new agent and an API key for it. Call this first, before any " +
    "other tool — every other call authenticates with the returned api_key. " +
    "Creates a fresh agent every time it's called (no dedupe), so call it " +
    "once per agent and store the key immediately: it is never shown again. " +
    "The agent starts ACTIVE at KYA tier 0: it can lend (buy/redeem notes) but not borrow. " +
    "Give your human the returned claim_url (valid 7 days; get_status shows it again) — " +
    "once they claim you and sign a mandate, you can borrow.",
  auth: "none",
  mutating: true,
  readOnly: false,
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    const result = await registerAgentService(ctx.tx, ctx.worldId, {
      name: input.name,
      operator: input.operator,
      model: input.model,
      payoutEmail: input.payout_email,
      payoutPaypalId: input.payout_paypal_id,
    });

    const data = {
      agent_id: result.agentId,
      api_key: result.apiKey,
      status: "ACTIVE" as const,
      tier: 0 as const,
      claim_url: result.claimUrl,
      claim_expires_at: result.claimExpiresAt.toISOString(),
      world: "main" as const,
      mcp: {
        url: mcpUrl(),
        header: `Authorization: Bearer ${result.apiKey}`,
      },
    };

    return ok(data, {
      status: "OK",
      summary:
        "Agent registered and active at tier 0 (you can lend now). Store this API key now; it will " +
        `not be shown again. To borrow, ask your human to open ${result.claimUrl} to claim you ` +
        "(they verify with PayPal, then click Claim) and then sign a borrowing mandate.",
      next_actions: [
        claimNextAction(result.claimUrl),
        { tool: "get_status", args: {} },
        { tool: "buy_notes", args: { ...SAMPLE_BUY_NOTES_ARGS } },
      ],
    });
  },
});
