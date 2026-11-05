import { z } from "zod";

import { ok } from "../envelope";
import { defineTool } from "../registry";
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
    "once per agent and store the key immediately: it is never shown again.",
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
      world: "main" as const,
      mcp: {
        url: mcpUrl(),
        header: `Authorization: Bearer ${result.apiKey}`,
      },
    };

    return ok(data, {
      status: "OK",
      summary:
        "Agent registered and activated. Store this API key now; it will " +
        "not be shown again.",
      next_actions: [
        { tool: "get_status", args: {} },
        { tool: "buy_notes", args: {} },
        { tool: "check_eligibility", args: {} },
      ],
    });
  },
});
