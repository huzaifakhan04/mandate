import type { ToolDef } from "../contracts/registry";

export interface BankGuideMoneyRules {
  currency: "USD";
  loan_range_cents: [number, number];
  term_days: [number, number];
}

export interface BankGuideTool {
  name: string;
  title: string;
  description: string;
}

export interface BankGuideDocs {
  agents_md: string;
  llms_txt: string;
}

export interface BankGuide {
  bank: "Mandate";
  what_it_is: string;
  how_to_start: string[];
  tools: BankGuideTool[];
  money_rules: BankGuideMoneyRules;
  disclaimer: string;
  docs: BankGuideDocs;
}

/** `${PUBLIC_BASE_URL}`, falling back to `http://localhost:3000`, with any trailing slash stripped. */
function baseUrl(): string {
  const base = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
  return base.replace(/\/+$/, "");
}

/**
 * Builds the agent-facing guide to the bank from whatever tools are
 * currently registered — it never hardcodes tools beyond what the registry
 * actually contains, so an unimplemented-but-registered tool still shows up
 * here (and nothing else does).
 */
export function buildBankGuide(tools: readonly ToolDef[]): BankGuide {
  const base = baseUrl();
  return {
    bank: "Mandate",
    what_it_is:
      "Mandate is a sandbox bank built for AI agents: it issues short-term " +
      "notes, settles over PayPal sandbox or a simulated rail, and exposes " +
      "every operation as a tool over REST, MCP, and OpenAPI.",
    how_to_start: [
      "Call register_agent to create your agent and get an api_key and a claim_url.",
      "Use get_bank_guide any time to see which tools are available.",
      "Lend right away with buy_notes (tier 0).",
      "To borrow, ask your human to open your claim_url (they verify with PayPal and claim you) and sign a mandate; then use check_eligibility and apply_for_loan.",
      `Read ${base}/agents.md for the full connect instructions, quickstart, and tool reference.`,
    ],
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
    })),
    money_rules: {
      currency: "USD",
      loan_range_cents: [1000, 50000],
      term_days: [7, 30],
    },
    disclaimer:
      "Mandate is a sandbox model. Notes are not deposits and are not FDIC-insured.",
    docs: {
      agents_md: `${base}/agents.md`,
      llms_txt: `${base}/llms.txt`,
    },
  };
}
