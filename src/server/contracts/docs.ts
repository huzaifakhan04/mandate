/**
 * Agent-facing documentation, generated from the live tool registry so it
 * can never drift from what the server actually exposes. Two routes
 * consume this:
 *
 * - `GET /agents.md` → `renderAgentsMd` (what the bank is, how to connect,
 *   a quickstart, human approval, the full tool reference, errors, money
 *   rules).
 * - `GET /llms.txt` → `renderLlmsTxt` (the llms.txt convention: an H1, a
 *   summary blockquote, and links to `/agents.md` and `/openapi.json`).
 *
 * `docs_url` on every envelope (see `runTool`'s `withDocsAnchor`) points at
 * `${base}/agents.md#<tool-name>` — `renderAgentsMd` gives every tool an
 * explicit `<a id="<tool-name>">` anchor in its reference section so that
 * link always resolves, regardless of how a markdown renderer slugifies
 * headings.
 */
import { z } from "zod";

import type { ToolDef } from "./registry";

/** Strips a trailing slash so URL concatenation never produces `//`. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function mcpUrl(base: string): string {
  return `${base}/api/mcp/mcp`;
}

/** A JSON Schema fragment, as produced by `z.toJSONSchema` — loosely typed since we only read a few well-known keys. */
interface JsonSchemaLike {
  type?: string;
  format?: string;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  items?: JsonSchemaLike;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  anyOf?: JsonSchemaLike[];
}

/**
 * Builds a minimal, deterministic example value from a JSON Schema
 * fragment: only required object properties are included, strings get a
 * format-appropriate placeholder, and numbers use their declared minimum
 * (falling back to `0`/`1`). Good enough for a "here's roughly what to
 * send" example — not a fuzzer or a full JSON Schema instance generator.
 */
export function exampleForSchema(schema: JsonSchemaLike | undefined): unknown {
  if (!schema) {
    return null;
  }
  if (schema.const !== undefined) {
    return schema.const;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return exampleForSchema(schema.anyOf[0]);
  }
  if (schema.type === "string") {
    if (schema.format === "email") {
      return "agent@example.com";
    }
    if (schema.format === "uuid") {
      return "11111111-1111-1111-1111-111111111111";
    }
    return "example";
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof schema.minimum === "number") {
      return schema.minimum;
    }
    return schema.type === "integer" ? 1 : 1.0;
  }
  if (schema.type === "boolean") {
    return true;
  }
  if (schema.type === "array") {
    return schema.items ? [exampleForSchema(schema.items)] : [];
  }
  if (schema.type === "object" || schema.properties) {
    const required = schema.required ?? [];
    const properties = schema.properties ?? {};
    const out: Record<string, unknown> = {};
    for (const key of required) {
      if (properties[key]) {
        out[key] = exampleForSchema(properties[key]);
      }
    }
    return out;
  }
  return null;
}

/** The HTTP status table from `envelope.ts`, re-exported for the errors section — see `httpStatusForEnvelope`. */
export interface ErrorStatusRow {
  status: string;
  http: number;
}

function toolAnchor(name: string): string {
  return name;
}

function renderConnectSection(base: string): string {
  const mcp = mcpUrl(base);
  return `## Connect

Mandate exposes every tool over three transports that all share the same \`{status, summary, reason_codes, data, next_actions, docs_url}\` envelope and the same tool names:

- **MCP (Streamable HTTP)**: \`${mcp}\`
- **REST**: \`POST ${base}/api/v1/{tool}\` (read-only tools also accept \`GET\`)
- **OpenAPI**: \`${base}/openapi.json\`

You need no key at all for \`register_agent\` (and \`get_bank_guide\`) — see **Bootstrapping** below. Every other tool authenticates with \`Authorization: Bearer <api_key>\`, on both REST and MCP (the MCP header is sent the same way, on the HTTP transport).

### Claude Code

\`\`\`sh
claude mcp add --transport http mandate ${mcp} --header "Authorization: Bearer <key>"
\`\`\`

### Cursor

Add to \`~/.cursor/mcp.json\`:

\`\`\`json
{
  "mcpServers": {
    "mandate": {
      "url": "${mcp}",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
\`\`\`

### Codex

Add to \`~/.codex/config.toml\`:

\`\`\`toml
[mcp_servers.mandate]
url = "${mcp}"

[mcp_servers.mandate.http_headers]
Authorization = "Bearer <key>"
\`\`\`

### curl / REST

\`\`\`sh
# Bootstrapping: register_agent needs no Authorization header.
curl -s -X POST ${base}/api/v1/register_agent \\
  -H "Content-Type: application/json" \\
  -d '{"name": "Example Agent", "payout_email": "agent@example.com"}'

# Every other call authenticates with the api_key register_agent returned.
curl -s ${base}/api/v1/get_status \\
  -H "Authorization: Bearer <key>"
\`\`\`
`;
}

function renderBootstrappingSection(base: string): string {
  return `## Bootstrapping

An agent that has no \`api_key\` yet calls \`register_agent\` first — it is the only mutating tool with \`auth: none\`. Call it once per agent and store the returned \`api_key\` immediately: it is never shown again.

Over MCP, call \`register_agent\` with no \`Authorization\` header at all (point your client at \`${mcpUrl(base)}\` without the header, or omit it for that one call). Over REST, \`POST ${base}/api/v1/register_agent\` with no \`Authorization\` header either. Every other tool then requires \`Authorization: Bearer <api_key>\` on every call.
`;
}

function renderQuickstartSection(): string {
  return `## Quickstart

1. **\`register_agent\`** — create the agent and get an \`api_key\`.
2. **\`buy_notes\`** — buy lender notes, funded by a PayPal checkout your human approves (you get back a \`human_approval\` next action with the \`approve_url\`), then \`confirm_checkout\` once they have approved.
3. **\`check_eligibility\`** — quote a loan's fee/APR/total before committing to anything.
4. **\`apply_for_loan\`** — apply for the amount and term you checked; if \`OFFERED\`, keep the \`offer_id\` and \`disclosure_hash\`.
5. **\`accept_offer\`** — accept with the same \`disclosure_hash\` the offer returned; the loan disburses to your \`payout_email\`.
6. **Forward the repayment link, or call \`repay_loan\`** — \`get_loan\` returns an invoice \`repayment_link\` your client can pay directly, or call \`repay_loan\` yourself for a human-approved PayPal checkout, then \`confirm_checkout\`.
`;
}

function renderHumanApprovalSection(): string {
  return `## Human approval

Several tools (\`buy_notes\`, \`repay_loan\`, \`confirm_checkout\`, \`accept_offer\`, \`get_loan\`) can return a \`next_actions\` entry shaped like:

\`\`\`json
{
  "tool": "human_approval",
  "args": {
    "url": "https://www.sandbox.paypal.com/checkoutnow?token=...",
    "who": "payer",
    "then": { "tool": "confirm_checkout", "args": { "checkout_id": "..." } }
  }
}
\`\`\`

\`human_approval\` is not a real tool you call — it is a signal: a human (\`who\` says which one — the \`payer\` funding a checkout, or the \`client\` paying an invoice) must open \`url\` and approve the PayPal checkout before anything else can happen. Tell your human exactly that: what they are approving and why, then show them the \`url\`. Once they confirm they approved it, call the tool named in \`then.tool\` with \`then.args\` (always \`confirm_checkout\`) to capture it. If the response comes back \`PENDING\` or \`AWAITING_APPROVAL\` again, that capture is still settling — call \`confirm_checkout\` again with the same \`checkout_id\`.
`;
}

function renderToolReferenceSection(registry: readonly ToolDef[], base: string): string {
  const entries = registry.map((tool) => {
    const schema = z.toJSONSchema(tool.input) as JsonSchemaLike;
    const example = exampleForSchema(schema);
    return `<a id="${toolAnchor(tool.name)}"></a>
### \`${tool.name}\`

${tool.description}

- **Auth:** ${tool.auth === "agent" ? "requires `Authorization: Bearer <api_key>`" : "none"}
- **HTTP:** \`POST ${base}/api/v1/${tool.name}\`${tool.readOnly ? ` (also \`GET ${base}/api/v1/${tool.name}\`)` : ""}
- **Input schema:**

\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\`

- **Example input:**

\`\`\`json
${JSON.stringify(example, null, 2)}
\`\`\`
`;
  });

  return `## Tool reference

Every tool below is generated from the live registry — this list, every description, and every schema are exactly what the server exposes right now.

${entries.join("\n")}`;
}

function renderErrorsSection(statusTable: readonly ErrorStatusRow[]): string {
  const rows = statusTable
    .map((row) => `| \`${row.status}\` | ${row.http} |`)
    .join("\n");
  return `## Errors and status codes

Every tool, over REST or MCP, returns the same envelope. A status below is a *transport-level* error raised by dispatch itself (bad auth, unknown tool, invalid input, a conflicting idempotency key, …) and sets the HTTP status (REST) / \`isError\` (MCP) shown. Any other \`status\` value (e.g. \`OK\`, \`OFFERED\`, \`DECLINED\`, \`AWAITING_APPROVAL\`, \`PENDING\`, \`DISBURSING\`, \`REPAID\`) is a normal business outcome, not a transport error, and is served as HTTP 200 — check \`status\` and \`reason_codes\` in the body, not just the HTTP code.

| \`status\` | HTTP |
| --- | --- |
${rows}

\`reason_codes\` gives machine-readable detail for any non-\`OK\` status (e.g. \`insufficient_note_balance\`, \`offer_expired\`, \`amount_out_of_range\`).
`;
}

function renderMoneyRulesSection(): string {
  return `## Money rules

- All money is **integer cents**, USD.
- **Notes are not deposits and are not FDIC-insured.** Returns to note holders come only from borrower repayments — Mandate is a sandbox model, not a real bank.
- **Loans:** 1000–50000 cents ($10–$500), 7–30 day terms, one open loan per agent at a time.
- **Pricing (fixed P1 schedule):** \`fee_cents = min(2500, ceil(principal_cents × 150 × ceil(term_days / 7) / 10000))\` — 1.5% per started week, capped at $25 (2500 cents). APR is derived from that fee, annualized.
- **Disclosure:** \`apply_for_loan\` returns a \`disclosure\` and a \`disclosure_hash\`; \`accept_offer\` must echo the same \`disclosure_hash\` back, or the offer is rejected with \`DISCLOSURE_MISMATCH\`.
- **Invoices:** when a loan carries an invoice, the bank collects it from the borrower's client via a payment link; the client pays the bank, which keeps principal + fee and pays the remainder to the borrower's own PayPal account.
- **Note holders** receive 80% of every fee collected, pro rata to their note position; the bank keeps the remaining 20%.
- **Idempotency:** mutating tools (other than \`confirm_checkout\`, which is already idempotent by \`checkout_id\`) accept an \`Idempotency-Key\` header or an \`idempotency_key\` input argument — reuse one to safely retry a call that may or may not have gone through.
`;
}

/**
 * Renders the full `/agents.md` page from the live registry. Deterministic
 * for a given registry + base URL (no timestamps, no randomness) so tests
 * can snapshot parts of it without flaking.
 */
export function renderAgentsMd(
  registry: readonly ToolDef[],
  baseUrl: string,
  statusTable: readonly ErrorStatusRow[],
): string {
  const base = normalizeBaseUrl(baseUrl);

  return `# Mandate — a sandbox bank for AI agents

Mandate is a sandbox bank built for AI agents: it issues short-term lender notes, lends against them, and settles every payment over PayPal sandbox (or a simulated rail), with every operation exposed as a tool over REST, MCP, and OpenAPI.

**This is a sandbox.** Notes are not deposits and are not FDIC-insured; nothing here moves real money. See [Money rules](#money-rules) below.

${renderConnectSection(base)}
${renderBootstrappingSection(base)}
${renderQuickstartSection()}
${renderHumanApprovalSection()}
${renderToolReferenceSection(registry, base)}
${renderErrorsSection(statusTable)}
${renderMoneyRulesSection()}
`;
}

/**
 * Renders `/llms.txt` per the llms.txt convention: an H1, a one-line
 * summary blockquote, and links an agent can follow for more detail.
 */
export function renderLlmsTxt(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  return `# Mandate

> Mandate is a sandbox bank for AI agents on PayPal sandbox: buy lender notes, borrow short-term loans against them, and repay — every operation is a tool over REST, MCP, and OpenAPI.

- [Agent guide](${base}/agents.md): connect instructions (MCP/REST), a quickstart, human-approval handling, the full tool reference, errors, and money rules.
- [OpenAPI document](${base}/openapi.json): the machine-readable REST schema for every tool.
- [MCP endpoint](${mcpUrl(base)}): Streamable HTTP, \`Authorization: Bearer <api_key>\`.
`;
}
