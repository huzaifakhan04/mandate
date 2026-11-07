import type { ToolDef } from "./registry";

/**
 * P7 (agent DX): per-tool metadata that is about *presentation* rather than
 * behaviour — MCP tool annotations, curated input examples, and the folder a
 * tool lives in for the Postman collection / SDK docs. Kept beside the
 * registry (keyed by tool name) so the tool modules stay focused on their
 * contracts; tests/unit/contracts/toolMeta.test.ts pins that every
 * registered tool has an entry and that every example passes its tool's
 * input schema as-is.
 */

/** Folders of the Postman collection (and the order judges see them in). */
export const TOOL_GROUPS = ["Start here", "Lend", "Borrow", "Repay", "Collections", "Treasury"] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

export interface ToolExample {
  /** One line: what this call does. */
  summary: string;
  args: Record<string, unknown>;
}

/** MCP `ToolAnnotations` hints (all four set explicitly for every tool). */
export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

interface ToolMetaEntry {
  group: ToolGroup;
  /**
   * Mutating tools only: does a call irreversibly destroy or give up
   * something (a pending offer, a queued redemption, money leaving the
   * bank)? Additive calls (create a checkout, an application) are false.
   */
  destructive?: boolean;
  /** Repeating the call with the same arguments has no further effect. Read-only tools are always idempotent. */
  idempotent?: boolean;
  /** The call reaches PayPal (or the simulated rail) — an external system. */
  openWorld?: boolean;
  examples: ToolExample[];
}

/** Placeholder ids in examples: valid UUIDs (so examples pass the schema), replaced with `{{variables}}` in Postman. */
export const EXAMPLE_IDS = {
  offer_id: "2b0f6c1e-8a43-4c7e-9a51-3f7d2e9b0c11",
  application_id: "7d3a9e52-1f6b-4b28-8c0d-5e4f1a2b3c22",
  loan_id: "9c1e4b7a-3d2f-4a6e-b8c9-0f1e2d3c4b33",
  note_tx_id: "4e8b2c6d-5a1f-4d3e-9b7c-1a2b3c4d5e44",
  notice_id: "6f2a8d4c-7b3e-4c1a-8d5f-2b3c4d5e6f55",
} as const;

/** A disclosure hash and checkout id as the bank returns them (opaque strings). */
export const EXAMPLE_DISCLOSURE_HASH = "sha256:<disclosure_hash from apply_for_loan>";
export const EXAMPLE_CHECKOUT_ID = "<checkout_id from buy_notes or repay_loan>";

const META: Record<string, ToolMetaEntry> = {
  get_bank_guide: {
    group: "Start here",
    examples: [{ summary: "Orientation: what the bank is, every tool, the money rules", args: {} }],
  },
  register_agent: {
    group: "Start here",
    examples: [
      {
        summary: "Register with a PayPal payout account (no API key needed)",
        args: { name: "Acme Ops Agent", operator: "Acme Ops", model: "claude-sonnet", payout_email: "agent@example.com" },
      },
    ],
  },
  get_status: {
    group: "Start here",
    examples: [{ summary: "Your agent, KYA tier, mandate, positions and open items", args: {} }],
  },
  register_public_key: {
    group: "Start here",
    idempotent: true,
    examples: [
      {
        summary: "Register an Ed25519 public key (base64) to sign requests",
        args: { public_key: "MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=" },
      },
    ],
  },
  buy_notes: {
    group: "Lend",
    openWorld: true,
    examples: [{ summary: "Fund the bank with $30 of notes (returns a PayPal checkout to approve)", args: { amount_cents: 3000 } }],
  },
  confirm_checkout: {
    group: "Lend",
    idempotent: true,
    openWorld: true,
    examples: [{ summary: "Capture a checkout after your human approved it", args: { checkout_id: EXAMPLE_CHECKOUT_ID } }],
  },
  redeem_notes: {
    group: "Treasury",
    destructive: true,
    openWorld: true,
    examples: [{ summary: "Redeem $10 of notes to your PayPal payout receiver", args: { amount_cents: 1000 } }],
  },
  cancel_redemption: {
    group: "Treasury",
    destructive: true,
    idempotent: true,
    examples: [{ summary: "Withdraw a queued redemption", args: { note_tx_id: EXAMPLE_IDS.note_tx_id } }],
  },
  check_eligibility: {
    group: "Borrow",
    examples: [
      {
        summary: "Quote $10 for 7 days against a $15 invoice",
        args: { amount_cents: 1000, term_days: 7, collateral: "invoice_link", invoice_amount_cents: 1500 },
      },
    ],
  },
  apply_for_loan: {
    group: "Borrow",
    examples: [
      {
        summary: "Apply (ALA A–H): $10 for 7 days, invoice-backed, with the required declarations and attestation",
        args: {
          amount_cents: 1000,
          term_days: 7,
          purpose: "Buy materials for invoice INV-1042",
          identity: { operator: "Acme Ops", model: "claude-sonnet" },
          invoice: {
            client_email: "client@example.com",
            amount_cents: 1500,
            due_in_days: 7,
            description: "INV-1042: website build",
          },
          declarations: { no_other_debt: true },
          consent_bank_records: true,
          attest: true,
        },
      },
    ],
  },
  get_application: {
    group: "Borrow",
    examples: [{ summary: "Re-read a decision, its reasons and adverse action", args: { application_id: EXAMPLE_IDS.application_id } }],
  },
  accept_offer: {
    group: "Borrow",
    destructive: true,
    openWorld: true,
    examples: [
      {
        summary: "Accept an offer with the disclosure hash it returned (disburses the loan)",
        args: { offer_id: EXAMPLE_IDS.offer_id, disclosure_hash: EXAMPLE_DISCLOSURE_HASH },
      },
    ],
  },
  decline_offer: {
    group: "Borrow",
    destructive: true,
    idempotent: true,
    examples: [{ summary: "Decline an offer you don't want", args: { offer_id: EXAMPLE_IDS.offer_id } }],
  },
  get_loan: {
    group: "Repay",
    examples: [{ summary: "Loan status, balance, repayment link and history", args: { loan_id: EXAMPLE_IDS.loan_id } }],
  },
  repay_loan: {
    group: "Repay",
    openWorld: true,
    examples: [
      { summary: "Repay the full outstanding balance (PayPal checkout)", args: { loan_id: EXAMPLE_IDS.loan_id } },
      { summary: "Repay part of it", args: { loan_id: EXAMPLE_IDS.loan_id, amount_cents: 500 } },
    ],
  },
  get_statement: {
    group: "Treasury",
    examples: [{ summary: "Your ledger statement: notes, loans, fees, payouts", args: {} }],
  },
  ack_notices: {
    group: "Collections",
    idempotent: true,
    examples: [
      { summary: "Acknowledge every open notice (late, dunning, rate change)", args: {} },
      { summary: "Acknowledge specific notices", args: { notice_ids: [EXAMPLE_IDS.notice_id] } },
    ],
  },
};

const FALLBACK: ToolMetaEntry = { group: "Start here", examples: [] };

/** The metadata entry for a tool, or `undefined` for an unknown name. */
export function toolMetaEntry(name: string): ToolMetaEntry | undefined {
  return META[name];
}

export function toolGroup(tool: Pick<ToolDef, "name">): ToolGroup {
  return (META[tool.name] ?? FALLBACK).group;
}

export function toolExamples(tool: Pick<ToolDef, "name">): ToolExample[] {
  return (META[tool.name] ?? FALLBACK).examples;
}

/** MCP tool annotations, derived from the registry flags plus the hints above. */
export function toolHints(tool: Pick<ToolDef, "name" | "readOnly">): ToolHints {
  const meta = META[tool.name] ?? FALLBACK;
  if (tool.readOnly) {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: meta.openWorld ?? false };
  }
  return {
    readOnlyHint: false,
    destructiveHint: meta.destructive ?? false,
    idempotentHint: meta.idempotent ?? false,
    openWorldHint: meta.openWorld ?? false,
  };
}

/**
 * The tool description as advertised over MCP: the registry description
 * plus one concise example call (compact JSON), so a client that only
 * reads `tools/list` still sees a valid input.
 */
export function describeWithExample(tool: Pick<ToolDef, "name" | "description">): string {
  const [first] = toolExamples(tool);
  if (!first) {
    return tool.description;
  }
  return `${tool.description}\n\nExample (${first.summary}): ${JSON.stringify(first.args)}`;
}
