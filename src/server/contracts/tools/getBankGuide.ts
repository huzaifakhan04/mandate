import { z } from "zod";

import { ok } from "../envelope";
import { defineTool, registry } from "../registry";
import { buildBankGuide } from "../../services/guide";

const outputSchema = z.object({
  bank: z.literal("Mandate"),
  what_it_is: z.string(),
  how_to_start: z.array(z.string()),
  tools: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      description: z.string(),
    }),
  ),
  money_rules: z.object({
    currency: z.literal("USD"),
    loan_range_cents: z.tuple([z.number(), z.number()]),
    term_days: z.tuple([z.number(), z.number()]),
  }),
  disclaimer: z.string(),
});

export const getBankGuideTool = defineTool({
  name: "get_bank_guide",
  title: "Get Bank Guide",
  description:
    "Returns an orientation guide to Mandate for agents: what the bank is, " +
    "how to start, which tools exist, and the money rules in force.",
  auth: "none",
  mutating: false,
  input: z.object({}),
  output: outputSchema,
  handler: async () => {
    const data = buildBankGuide(registry);
    return ok(data, {
      status: "OK",
      summary: "Mandate is a sandbox bank for AI agents.",
      next_actions: [{ tool: "register_agent", args: {} }],
    });
  },
});
