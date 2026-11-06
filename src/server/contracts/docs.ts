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

import { PRICING_LIMITS } from "../domain/pricing";
import {
  APR_FLAG_THRESHOLD_BPS,
  BASE_RATE_BPS,
  CAPITAL_PCT_OF_PD_BPS,
  LGD_BPS,
  MIN_FEE_CENTS,
  OPS_BPS,
  PD_BPS,
  priceLoan,
  totalBps,
} from "../domain/pricingV2";
import {
  BASE_RATE_MAX_BPS,
  BASE_RATE_MIN_BPS,
  BASE_RATE_STEP_BPS,
  UTILIZATION_DECLINE_ABOVE_BPS,
  UTILIZATION_PREMIUM_FLOOR_BPS,
  UTILIZATION_PREMIUM_MAX_BPS,
  utilizationPremiumBps,
} from "../domain/economy";
import { TREASURY_DEFAULTS } from "../domain/treasury";
import { MAX_SHOWN_REASONS, REASON_PRIORITY, REASON_TEXT } from "../domain/reasons";
import { GRADE_D_AUTO_APPROVE_MAX_CENTS } from "../domain/rules";
import {
  COMPONENT_MAX,
  computeScore,
  GRADE_LIMIT_CENTS,
  gradeFor,
  IDENTITY_POINTS,
  ON_TIME_LOAN_POINTS,
  TENURE_DAYS_PER_POINT,
} from "../domain/scorecard";
import { TIER_MAX_PER_LOAN_CENTS } from "../domain/kya";
import { ADVERSE_ACTION_NOTICE } from "../services/adverseAction";
import type { ToolDef } from "./registry";

/** Strips a trailing slash so URL concatenation never produces `//`. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function mcpUrl(base: string): string {
  return `${base}/api/mcp/mcp`;
}

export type McpClientId = "claudeCode" | "cursor" | "codex";

/** The MCP clients agents.md (and the dashboard's path-B result page) give a config for. */
export const MCP_CLIENTS: ReadonlyArray<{ id: McpClientId; title: string; where: string | null; lang: string }> = [
  { id: "claudeCode", title: "Claude Code", where: null, lang: "sh" },
  { id: "cursor", title: "Cursor", where: "~/.cursor/mcp.json", lang: "json" },
  { id: "codex", title: "Codex", where: "~/.codex/config.toml", lang: "toml" },
];

/**
 * The MCP config for each client, with `key` as the bearer (agents.md
 * shows the `<key>` placeholder; the dashboard's path-B result page shows
 * the agent's real key, once).
 */
export function mcpConfigSnippets(baseUrl: string, key = "<key>"): Record<McpClientId, string> {
  const mcp = mcpUrl(normalizeBaseUrl(baseUrl));
  return {
    claudeCode: `claude mcp add --transport http mandate ${mcp} --header "Authorization: Bearer ${key}"`,
    cursor: `{
  "mcpServers": {
    "mandate": {
      "url": "${mcp}",
      "headers": { "Authorization": "Bearer ${key}" }
    }
  }
}`,
    codex: `[mcp_servers.mandate]
url = "${mcp}"

[mcp_servers.mandate.http_headers]
Authorization = "Bearer ${key}"`,
  };
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

const FENCE = "```";

function renderClientSections(snippets: Record<McpClientId, string>): string {
  return MCP_CLIENTS.map((client) => {
    const where = client.where ? `Add to \`${client.where}\`:\n\n` : "";
    return `### ${client.title}\n\n${where}${FENCE}${client.lang}\n${snippets[client.id]}\n${FENCE}\n`;
  }).join("\n");
}

function renderConnectSection(base: string): string {
  const mcp = mcpUrl(base);
  const snippets = mcpConfigSnippets(base);
  return `## Connect

Mandate exposes every tool over three transports that all share the same \`{status, summary, reason_codes, data, next_actions, docs_url}\` envelope and the same tool names:

- **MCP (Streamable HTTP)**: \`${mcp}\`
- **REST**: \`POST ${base}/api/v1/{tool}\` (read-only tools also accept \`GET\` with the input as query parameters, e.g. \`GET ${base}/api/v1/get_loan?loan_id=…\`)
- **OpenAPI**: \`${base}/openapi.json\`

You need no key at all for \`register_agent\` (and \`get_bank_guide\`) — see **Bootstrapping** below. Every other tool authenticates with \`Authorization: Bearer <api_key>\`, on both REST and MCP (the MCP header is sent the same way, on the HTTP transport).

${renderClientSections(snippets)}
### curl / REST

\`\`\`sh
# Bootstrapping: register_agent needs no Authorization header.
curl -s -X POST ${base}/api/v1/register_agent \\
  -H "Content-Type: application/json" \\
  -d '{"name": "Example Agent", "payout_email": "agent@example.com"}'

# Or name the payout receiver by its PayPal account (payer) id instead of an email:
# use this when you were given an account id, or the account's email is unconfirmed.
curl -s -X POST ${base}/api/v1/register_agent \\
  -H "Content-Type: application/json" \\
  -d '{"name": "Example Agent", "payout_paypal_id": "ABCDEFGHJ2345"}'

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

1. **\`register_agent\`** — create the agent and get an \`api_key\` and a \`claim_url\`. You start at tier 0: you can lend now; to borrow, give your human the \`claim_url\` (see [Claiming and KYA tiers](#claiming-and-kya-tiers)).
2. **\`buy_notes\`** — buy lender notes, funded by a PayPal checkout your human approves (you get back a \`human_approval\` next action with the \`approve_url\`), then \`confirm_checkout\` once they have approved.
3. **\`check_eligibility\`** — quote a loan's fee/APR/total before committing to anything (needs tier ≥ 1: claimed by your human, who has signed a mandate).
4. **\`apply_for_loan\`** — apply for the amount and term you checked, with \`declarations: {"no_other_debt": true}\` and \`attest: true\` (required — see [Applying for a loan](#applying-for-a-loan)); if \`OFFERED\`, keep the \`offer_id\` and \`disclosure_hash\`; if \`DECLINED\`, read \`data.adverse_action\`.
5. **\`accept_offer\`** — accept with the same \`disclosure_hash\` the offer returned; the loan disburses to your payout receiver (\`payout_email\`, or \`payout_paypal_id\` if that account's email is unconfirmed).
6. **Forward the repayment link, or call \`repay_loan\`** — \`get_loan\` returns an invoice \`repayment_link\` your client can pay directly, or call \`repay_loan\` yourself for a human-approved PayPal checkout, then \`confirm_checkout\`.
`;
}

function renderClaimingSection(base: string): string {
  return `## Claiming and KYA tiers

Every agent that registers itself is \`ACTIVE\` at **KYA tier 0**. What you may do depends on your tier, which the bank computes from your facts every time (\`get_status\` → \`data.kya\`, with \`borrow_blockers\` saying what is still missing):

| Tier | Requirement | May lend | May borrow |
| --- | --- | --- | --- |
| T0 | unclaimed | yes (buy/redeem notes) | no — \`apply_for_loan\` → \`CLAIM_REQUIRED\` (403) with \`data.claim_url\` |
| T1 | claimed by a PayPal-verified human **and** a signed mandate | yes | within the mandate's limits, per loan ≤ 25000 cents |
| T2 | T1 + an approved KYA document + a registered Ed25519 key ([Signing requests](#signing-requests-optional-unlocks-tier-t2)) | yes | within the mandate's limits, per loan ≤ 50000 cents |

**What unlocks each tier:**

- **T0 → T1** takes two steps by your human: they claim you (below), then sign a mandate in their dashboard ([Mandates](#mandates)). \`borrow_blockers\` goes \`claim_required\` → \`mandate_missing\` → empty.
- **T1 → T2** takes one step by you and one by your human: you register an Ed25519 key with \`register_public_key\` (and sign every mutating call from then on), and your human uploads a KYA document (e.g. an operator registration) in their dashboard.

**Claiming — send your human the \`claim_url\`.** \`register_agent\` returns a \`claim_url\` (\`${base}/claim/<token>\`, valid 7 days, single use). Ask your human to open <claim_url>: give them the link and say what it is for ("claim me as your agent so I can borrow within limits you set"). On that page they:

1. click **Verify with PayPal** and approve a $0.01 identity check in PayPal (it is never charged — the bank only reads which PayPal account approved it), which brings them back to the claim page;
2. click **Claim agent**;
3. open their dashboard (\`${base}/dashboard\`) and sign your mandate.

You can't do these steps yourself and you don't need to poll: once your human tells you they are done, call \`get_status\` (\`data.kya.tier\` ≥ 1, \`can_borrow: true\`). Until you are claimed, \`get_status\` keeps showing your \`claim_url\`; \`next_actions\` carries it as a \`human_approval\` with \`"who": "owner"\`. If the 7 days ran out, any call that shows you the link issues a fresh one: \`get_status\` and \`check_eligibility\` are read-only tools, but while you are unclaimed they (like \`apply_for_loan\`'s \`CLAIM_REQUIRED\`) **rotate an expired claim link** — the old link stops working, so always pass on the latest \`claim_url\`. Treat the link like a password: give it only to your own human.

**Mandate:** once claimed, your human signs a mandate in their dashboard that sets your borrowing limits (see [Mandates](#mandates)). Until then, \`check_eligibility\` lists \`mandate_missing\` and \`apply_for_loan\` returns \`MANDATE_REQUIRED\` (403).
`;
}

function renderMandatesSection(): string {
  return `## Mandates

A **mandate** is the standing permission your human signs for you: the limits within which you may borrow on their behalf. Your human is the borrower of record. They sign it in their dashboard (a checkbox plus their typed full name; the bank stores the time, a hash of their IP and the sha256 of the signed terms). Each change is a new **version**; signing one replaces the previous version. Revoking it stops new borrowing; loans you already took are unaffected.

**What your human sets:**

| Limit | Meaning |
|---|---|
| \`max_per_loan_cents\` | the principal of any one loan |
| \`max_total_owed_cents\` | what your human may owe in total **across all their agents**: what they owe on every open loan + this loan's principal + fee |
| \`max_fee_bps\` | the loan's fee as basis points of its principal (500 = at most 5% of the principal; a new agent's grade D invoice-backed loans need about 600 — see [The newcomer path](#the-newcomer-path)) |
| \`max_term_days\` | the loan's term |
| \`eligible_collateral\` | \`invoice_link\` (you pass an \`invoice\` the bank collects) and/or \`none\` (unsecured) |
| \`expires_at\` | optional; after it the mandate is no longer in force |

Your per-loan ceiling is the smaller of your credit grade's limit (A 50000, B 30000, C 20000, D 10000 cents), your tier's cap (T1 25000, T2 50000 cents) and \`max_per_loan_cents\` (\`check_eligibility\` returns it as \`effective_cap_cents\`).

**What you see:** \`check_eligibility\` returns \`data.mandate\` — \`mandate_id\`, \`version\`, every limit, \`principal_total_owed_cents\` (what your human owes now), \`total_owed_headroom_cents\` (how much more principal + fee they may take on) and \`per_loan_cap_cents\`. Pass \`collateral\` to also check the collateral rule. An offer's \`disclosure\` names the \`mandate_id\` and \`mandate_version\` it was made under (both covered by \`disclosure_hash\`).

**Reason codes** (in \`check_eligibility\` reasons, and on a \`DECLINED\` \`apply_for_loan\`):

| Code | Meaning |
|---|---|
| \`mandate_missing\` | no mandate in force — ask your human to sign one (\`apply_for_loan\` → \`MANDATE_REQUIRED\`, 403) |
| \`mandate_per_loan\` | the amount is above \`max_per_loan_cents\` |
| \`mandate_total_owed\` | your human's total owed + this principal + fee would be above \`max_total_owed_cents\` |
| \`mandate_fee\` | the fee is above \`max_fee_bps\` of the principal |
| \`mandate_term\` | the term is above \`max_term_days\` |
| \`mandate_collateral\` | the collateral kind (invoice or none) is not in \`eligible_collateral\` |
| \`tier_per_loan\` | the amount is above your KYA tier's per-loan cap |

**At acceptance** the bank checks the mandate again (serialised with every other acceptance, so two of your human's agents can't both squeeze under \`max_total_owed_cents\`):

- \`MANDATE_REVOKED\` (409) with \`mandate_revoked\` — the mandate was revoked or expired; ask your human to sign a new one.
- \`MANDATE_REVOKED\` (409) with \`mandate_superseded\` — your human signed a new version after the offer; check eligibility and apply again.
- \`MANDATE_LIMIT\` (400) with the \`mandate_*\` / \`tier_per_loan\` reasons — the offer no longer fits (typically another of your human's agents borrowed meanwhile); \`data\` carries the current limits and headroom.

**Two clocks.** A mandate is a document your human signs, so its \`expires_at\` is **real calendar time**: it lapses at that wall-clock moment in every world, however far a world's simulated clock has been moved. Everything about loans — an offer's expiry, a loan's due date, accrual — runs on the world's **simulated clock** (the main world's runs at real speed; a private world's can be fast-forwarded). An expired mandate behaves like a revoked one: \`mandate_missing\` at check/apply, \`MANDATE_REVOKED\` (\`mandate_revoked\`) at accept.
`;
}

function renderSigningSection(base: string): string {
  return `## Signing requests (optional, unlocks tier T2)

Signing is optional. A claimed agent with a signed mandate is T1; registering an Ed25519 key **and** having your human upload an approved KYA document (in their dashboard) makes you **T2** (per loan ≤ 50000 cents).

**How a request is signed.** Build this string (\`\\n\` separated, no trailing newline):

\`\`\`text
\${timestamp}\\n\${METHOD}\\n\${path}\\n\${sha256hex(body)}
\`\`\`

- \`timestamp\`: unix seconds; must be within **±300 s** of the bank's clock.
- \`METHOD\`: \`POST\`. \`path\`: the URL path only — \`/api/v1/<tool>\` over REST, \`/api/mcp/mcp\` over MCP.
- \`body\`: the **exact bytes** you send (over MCP, the whole JSON-RPC request body). Sign the string you send, not a re-serialisation of it.

Sign it with your Ed25519 private key and send:

| Header | Value |
| --- | --- |
| \`X-Mandate-Timestamp\` | the \`timestamp\` above |
| \`X-Mandate-Signature\` | base64 of the 64-byte Ed25519 signature |
| \`X-Mandate-Previous-Signature\` | key rotation only: the same string signed by your **current** key |

**Register your key** with \`register_public_key\` (\`public_key\`: base64 SPKI DER or raw 32 bytes). That request must itself be signed by the key you are registering. Calling it again with a different key rotates (the old key is revoked) and also needs \`X-Mandate-Previous-Signature\` from the current key.

**Once a key is registered, every mutating call must be signed** (read-only tools like \`get_status\` need not be). Each signature is single-use: to retry a call, sign it again with a fresh timestamp and reuse its \`Idempotency-Key\` so it can't run twice. Over MCP, send exactly **one** \`tools/call\` per signed HTTP request — the signature covers the whole JSON-RPC body, so JSON-RPC batches (an array of calls in one body) are not supported for signed requests.

| Status (HTTP 401) | Meaning |
| --- | --- |
| \`SIGNATURE_REQUIRED\` | you have a key, but the headers are missing (or \`previous_signature_required\` on rotation) |
| \`SIGNATURE_INVALID\` | the signature doesn't verify (wrong key, body, path, or malformed header) |
| \`SIGNATURE_EXPIRED\` | \`X-Mandate-Timestamp\` is more than 300 s off |
| \`SIGNATURE_REPLAYED\` | this exact signature was already used |

\`\`\`js
// Node 20+
import { createHash, generateKeyPairSync, sign } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519"); // keep privateKey secret
const publicKeyB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

async function signedPost(tool, args, apiKey) {
  const path = \`/api/v1/\${tool}\`;
  const body = JSON.stringify(args);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHash("sha256").update(body).digest("hex");
  const signature = sign(null, Buffer.from(\`\${timestamp}\\nPOST\\n\${path}\\n\${digest}\`), privateKey).toString("base64");
  const res = await fetch(\`${base}\${path}\`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: \`Bearer \${apiKey}\`,
      "x-mandate-timestamp": timestamp,
      "x-mandate-signature": signature,
    },
    body,
  });
  return res.json();
}

await signedPost("register_public_key", { public_key: publicKeyB64 }, process.env.MANDATE_API_KEY);
\`\`\`
`;
}

function renderPrivateWorldsSection(base: string): string {
  return `## Private worlds

The main world is the shared bank on PayPal sandbox. A **private world** is a separate, sandboxed copy of the bank that belongs to one human: simulated money only (the \`sim\` rail — no PayPal), with its own ledger, notes, loans and clock. Nothing in it shows up in the main world, and nothing from the main world shows up in it.

- **Who creates one:** a PayPal-verified human, in their dashboard (\`${base}/dashboard/worlds\` → **Create a world**), up to 3 at a time. Agents can't create worlds.
- **What's inside:** two lender bots and two borrower bots (with their own mandate) that buy notes, borrow and repay once per simulated day, so the pool has liquidity and activity. Their funds are simulated.
- **Clock controls:** the owner moves the world's clock **+1 day** or **+7 days** (the bots act for each day that passes, so terms, due dates and repayments play out in minutes) or **Reset**s it to a fresh world.
- **Agents in a private world:** the human registers the agent from their dashboard (\`${base}/dashboard/agents/new\`, choosing the world). Its API key is **bound to that world**: every call made with it — over REST or MCP, at the same URLs as the main world — acts in that world only. To act in another world you need an agent registered there, with its own key. Such an agent is already claimed by that human; it can borrow once they sign its mandate.

- **Approvals in a private world:** checkouts there are simulated, so a \`human_approval\` \`url\` points at your human's own approval page (\`${base}/dashboard/worlds/<world_id>/checkouts/<checkout_id>/approve\`) instead of PayPal. Hand it over exactly as in the main world: your human opens it while signed in to their dashboard, clicks **Approve** (no PayPal login, no money moves), and you then call \`confirm_checkout\`. Only the world's owner can approve; anyone else gets a 404.

Use a private world to rehearse (buy notes, borrow, let the term pass, repay) with simulated approvals, then do it for real in the main world.
`;
}

function renderLateSection(base: string): string {
  return `## When you're late

Every loan has a due date on the world's simulated clock (\`get_loan\` → \`due_sim_at\`). If it isn't repaid by then, the bank walks it down a **delinquency ladder**, by how many simulated days it is past due. Each step happens exactly once, and each one writes a **notice** to you and to your human.

| Days past due | Step | What happens |
|---|---|---|
| +1 | \`late\` | Status \`LATE\`. A late fee of \`min(500, max(100, 5% × outstanding principal))\` cents is added. Your credit score takes a −15 entry. |
| +3 | \`penalty\` | A rate penalty of 2% a year on the outstanding principal accrues **daily**, counted from the due date: \`ceil(outstanding principal × 200 × days_late / (10000 × 365))\` cents in total. It stops growing at +10. |
| +7 | \`substandard\` | Status \`SUBSTANDARD\`. You become \`restricted\`: you can't apply for or accept loans, but you **can still repay** (\`repay_loan\`, \`confirm_checkout\`) and acknowledge notices. Your human's mandate is **frozen** for new loans across all their agents: \`check_eligibility\` / \`apply_for_loan\` give \`delinquent_principal\`, and \`accept_offer\` returns \`MANDATE_FROZEN\` (409). |
| +10 | \`charged_off\` | Status \`CHARGED_OFF\`. The bank writes the loan off: principal + fee + late fees + penalty at that moment. Note holders bear the principal loss pro rata to their notes. **Your human's guarantee is invoked:** the bank sends them a payment link (on their dashboard) for the full written-off amount. You stay restricted and the mandate stays frozen until it is recovered. |
| any time after | \`recovered\` | Any payment after charge-off — the guarantee, the invoice link, or \`repay_loan\` — is a **recovery**. Note holders are made whole first. Once the full written-off amount is back, the status is \`RECOVERED\`, your restriction lifts and the freeze ends. Anything paid beyond it is refunded to your payout receiver. |

**Where you see it.** \`get_status\` → \`data.open_loan\` carries \`status\`, \`days_late\`, \`late_fee_cents\`, \`penalty_cents\` and \`total_due_cents\` (what settles the loan now; once charged off, what is still recoverable, plus the \`guarantee_link\`). \`data.notices\` lists your **unread notices** — \`{notice_id, kind, loan_id, sim_at, body}\`, with \`kind\` one of \`late\`, \`penalty\`, \`substandard\`, \`charged_off\`, \`recovery\`, \`recovered\`, \`cured\`. \`get_loan\` shows the same fields for one loan, its notices, and \`charge_off\` (\`written_off_cents\`, \`recovered_cents\`, \`guarantee_link\`). Check \`get_status\` whenever you resume work.

**What to do with a notice.** Read it, **tell your human what it means for them** — what is owed now, what the next step is and when, and that at +10 their guarantee is invoked — then call \`ack_notices\` (all unread, or \`notice_ids\`) so it stops being listed. \`ack_notices\` changes nothing about the loan; your human's dashboard keeps its own read state.

**Waterfall.** Every payment on a late loan is applied in this order: **late fees → rate penalty → fee → principal → remainder** (anything left over is refunded to your payout receiver).

**Quotes (pay exactly what you were quoted).** \`repay_loan\` without \`amount_cents\` quotes the full payoff (\`total_due_cents\`) at that moment. If your human pays that checkout for exactly the quoted amount, the loan is **cured** (\`REPAID\`) even if a late fee or more penalty landed between the quote and the capture: those post-quote charges are **waived**. A partial \`amount_cents\` (or the invoice link) carries no quote: it is applied through the waterfall and the penalty accrues up to when it is captured. The same rule holds after charge-off: a quoted payoff paid as quoted fully recovers the loan. **Small balances:** once the principal and fee are fully paid, late fees + penalty still owed of **100 cents or less** are waived and the loan is cured. **Cure:** paying everything owed before +10 returns the loan to \`REPAID\`, and you go back to \`active\` once you have no other substandard or charged-off loan.

**How collection works.** The bank never debits anyone automatically: every collection is a **payment link** a human approves — the invoice link your client pays, a \`repay_loan\` checkout your human approves, or, after charge-off, the guarantee link on your human's dashboard (\`${base}/dashboard\`; in a private world it is their sim approve page). A saved-card auto-debit is not offered. Once a loan is cured or fully recovered, its other open payment links are \`CLOSED\`; anything still paid through one is applied and the excess refunded.

In a private world your human can move the clock (+1 / +7 days) to walk a loan through this ladder in minutes — see [Private worlds](#private-worlds).
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

\`human_approval\` is not a real tool you call — it is a signal: a human (\`who\` says which one — the \`payer\` funding a checkout, or the \`client\` paying an invoice) must open \`url\` and approve the PayPal checkout before anything else can happen. Tell your human exactly that: what they are approving and why, then show them the \`url\`. Once they confirm they approved it, call the tool named in \`then.tool\` with \`then.args\` (\`confirm_checkout\` for a checkout) to capture it. If the response comes back \`PENDING\` or \`AWAITING_APPROVAL\` again, that capture is still settling — call \`confirm_checkout\` again with the same \`checkout_id\`.

With \`"who": "owner"\` the \`url\` is not a checkout: it is your claim link or your owner's dashboard (to sign a mandate) — see [Claiming and KYA tiers](#claiming-and-kya-tiers). Show it to your human; once they are done, \`then\` is \`get_status\`.
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

**\`AGENT_NOT_ACTIVE\` (403)** means your human froze you (or you were revoked). Read-only tools keep working. While **frozen**, the money-in tools still work too — \`repay_loan\` and \`confirm_checkout\` — so you can always repay an open loan; buying or redeeming notes, applying for, accepting or declining loans and registering a key are refused until your human unfreezes you. A revoked agent can't call any mutating tool.
`;
}

/** Lowest score of each grade, from the live `gradeFor` (so the table can't drift from the scorecard). */
function gradeFloors(): Array<{ grade: string; floor: number }> {
  const floors: Array<{ grade: string; floor: number }> = [];
  for (let score = 100; score >= 0; score -= 1) {
    const grade = gradeFor(score);
    const last = floors[floors.length - 1];
    if (last && last.grade === grade) {
      last.floor = score;
    } else {
      floors.push({ grade, floor: score });
    }
  }
  return floors;
}

function pct(bps: number): string {
  return `${bps / 100}%`;
}

function usd(cents: bigint | number): string {
  const value = BigInt(cents);
  return `$${(value / 100n).toString()}.${(value % 100n).toString().padStart(2, "0")}`;
}

/** The newcomer worked example: a fresh T1 agent borrowing 1000 for 7 days against a 1500 invoice. */
function newcomerExample() {
  const principal = 1000n;
  const invoice = 1500n;
  const term = 7;
  const facts = {
    claimed: true,
    hasSigningKey: false,
    hasApprovedDocument: false,
    onTimeRepaidLoans: 0,
    lateRepayments: 0,
    everChargedOff: false,
    tenureDays: 0,
    exposureCents: 0n,
    maxTotalOwedCents: 5000n,
  };
  const secured = computeScore({ ...facts, invoiceCoverageBps: Number((invoice * 10000n) / principal) });
  const unsecured = computeScore({ ...facts, invoiceCoverageBps: null });
  const grade = secured.grade === "E" ? "D" : secured.grade;
  const coverageBps = Number((invoice * 10000n) / principal);
  const price = priceLoan({ principalCents: principal, termDays: term, grade, coverageBps });
  // The grade C route: a T2 agent (signing key + approved KYA document) with the same 1.5× invoice.
  const verified = computeScore({ ...facts, hasSigningKey: true, hasApprovedDocument: true, invoiceCoverageBps: coverageBps });
  const verifiedPrice = priceLoan({
    principalCents: principal,
    termDays: term,
    grade: verified.grade === "E" ? "D" : verified.grade,
    coverageBps,
  });
  // The highest fee (bps of principal) a grade D invoice-backed newcomer loan can cost, over every amount up to the auto-approval limit and every term.
  let maxNewcomerFeeBps = 0;
  for (const p of [PRICING_LIMITS.minPrincipalCents, GRADE_D_AUTO_APPROVE_MAX_CENTS]) {
    for (let t = PRICING_LIMITS.minTermDays; t <= PRICING_LIMITS.maxTermDays; t++) {
      const fee = priceLoan({ principalCents: p, termDays: t, grade: "D", coverageBps: 15000 }).feeCents;
      maxNewcomerFeeBps = Math.max(maxNewcomerFeeBps, Number((fee * 10000n + p - 1n) / p));
    }
  }
  const neededMaxFeeBps = Math.ceil(maxNewcomerFeeBps / 100) * 100;
  return { principal, invoice, term, secured, unsecured, price, verified, verifiedPrice, maxNewcomerFeeBps, neededMaxFeeBps };
}

function renderUnderwritingSection(): string {
  const floors = gradeFloors();
  const ex = newcomerExample();
  const c = ex.price.components;
  const sum = totalBps(c);
  const exactFee = (Number(ex.principal) * sum) / 10000;
  const pdRows = (["A", "B", "C", "D"] as const)
    .map((g) => `| ${g} | ${pct(PD_BPS[g])} | ${(PD_BPS[g] * LGD_BPS.unsecured) / 10000} | ${(PD_BPS[g] * LGD_BPS.invoiceCovered) / 10000} | ${(CAPITAL_PCT_OF_PD_BPS * PD_BPS[g]) / 10000} |`)
    .join("\n");
  const gradeRows = floors
    .map(({ grade, floor }, i) => {
      const range = i === 0 ? `${floor}–100` : `${floor}–${floors[i - 1]!.floor - 1}`;
      const limit = GRADE_LIMIT_CENTS[grade as keyof typeof GRADE_LIMIT_CENTS];
      const approval =
        grade === "E"
          ? "always declined (`insufficient_credit_history` with no repayment history, else `score_too_low`)"
          : grade === "D"
            ? `auto-approved up to ${GRADE_D_AUTO_APPROVE_MAX_CENTS.toString()} cents; above that \`manual_review_declined\``
            : "auto-approved up to the limit";
      return `| ${grade} | ${range} | ${limit} | ${approval} |`;
    })
    .join("\n");
  const reasonRows = REASON_PRIORITY.map((code) => `| \`${code}\` | ${REASON_TEXT[code]} |`).join("\n");

  return `## Credit score and underwriting

Every \`check_eligibility\` and \`apply_for_loan\` computes your **Agent Credit Score** (0–100) from the bank's own records — never from anything an AI writes — and records it with its component breakdown. \`check_eligibility\` shows your \`score\`, \`grade\`, the components and the price before you apply.

### Score components

| Component | Points | How you earn them |
|---|---|---|
| Identity | 0–${COMPONENT_MAX.identity} | claimed by a verified human ${IDENTITY_POINTS.claimed}, a registered signing key ${IDENTITY_POINTS.signingKey}, an approved KYA document ${IDENTITY_POINTS.approvedDocument} |
| Repayment history | 0–${COMPONENT_MAX.history} | ${ON_TIME_LOAN_POINTS} per loan of ≥ ${PRICING_LIMITS.minPrincipalCents.toString()} cents repaid on time (capped at ${COMPONENT_MAX.history}); late repayments and charge-offs subtract |
| Tenure | 0–${COMPONENT_MAX.tenure} | 1 per ${TENURE_DAYS_PER_POINT} simulated days since you registered |
| Collateral | 0–${COMPONENT_MAX.collateral} | for an invoice-backed request: invoice ≥ 1.5× the amount ${COMPONENT_MAX.collateral}, ≥ 1.1× 12, none 0 |
| Exposure | 0–${COMPONENT_MAX.exposure} | ${COMPONENT_MAX.exposure} − ${COMPONENT_MAX.exposure} × (what your human already owes ÷ their mandate's \`max_total_owed_cents\`), at least 0 |

### Grades and limits

| Grade | Score | Per-loan limit (cents) | Approval |
|---|---|---|---|
${gradeRows}

Your effective per-loan cap is the smallest of your grade's limit, your tier's cap (T1 ${TIER_MAX_PER_LOAN_CENTS[1]}, T2 ${TIER_MAX_PER_LOAN_CENTS[2]}) and your mandate's \`max_per_loan_cents\`.

### The newcomer path

A brand-new, claimed agent has no repayment history, so an **unsecured** first loan scores ${ex.unsecured.score} (grade ${ex.unsecured.grade}) and is declined with \`insufficient_credit_history\`. Start with a **small invoice-backed loan**: an invoice of at least **1.5×** the amount adds ${COMPONENT_MAX.collateral} points — ${ex.secured.score}, grade ${ex.secured.grade} — and grade D is auto-approved up to ${usd(GRADE_D_AUTO_APPROVE_MAX_CENTS)} (${GRADE_D_AUTO_APPROVE_MAX_CENTS.toString()} cents). (An invoice of only 1.1× adds 12 — still grade E. The invoice must also cover principal + fee.) Every such loan of ≥ ${usd(PRICING_LIMITS.minPrincipalCents)} repaid on time adds ${ON_TIME_LOAN_POINTS} points of history, which is how you climb to C and above.

**Your human's mandate must allow the grade D fee.** A grade D invoice-backed loan costs ${pct(Number((ex.price.feeCents * 10000n) / ex.principal))} of the principal for ${ex.term} days (${ex.price.feeCents.toString()} cents on ${ex.principal.toString()}) and up to ${pct(ex.maxNewcomerFeeBps)} for ${PRICING_LIMITS.maxTermDays} days, so the mandate's \`max_fee_bps\` must be at least **~${pct(ex.neededMaxFeeBps)} (${ex.neededMaxFeeBps} bps)** — below that every newcomer loan is declined with \`mandate_fee\` (the next step then names the mandate's current max fee and the fee you were quoted). The dashboard's mandate form defaults to 10%. A signed mandate never changes by itself: if your human signed one at a lower max fee (e.g. 5%), they must sign a new version with a higher one.

**The grade C route.** With a registered signing key (\`register_public_key\`) and an approved KYA document (tier 2: +${IDENTITY_POINTS.signingKey + IDENTITY_POINTS.approvedDocument} identity points), the same 1.5× invoice-backed loan scores ${ex.verified.score} — grade ${ex.verified.grade} — and costs ${pct(Number((ex.verifiedPrice.feeCents * 10000n) / ex.principal))} for ${ex.term} days (${ex.verifiedPrice.feeCents.toString()} cents), which fits under a 5% max fee.

**Which score?** \`get_status\` shows your *base* score (no collateral — there is no application). \`check_eligibility\` with \`invoice_amount_cents\`, and every stored application (\`credit_scores\`, \`score_history\`, \`adverse_action.score\`), include the collateral points of that request, so an invoice-backed application can show a score up to ${COMPONENT_MAX.collateral} points higher than \`get_status\`.

### Pricing

The fee is the sum of four components, each in basis points (bps) of the principal for the whole term:

- **cost of funds** = round((base rate + utilization premium) bps a year × term_days ÷ 365);
- **expected loss** = PD × LGD — probability of default by grade, times loss given default: ${pct(LGD_BPS.unsecured)} unsecured, ${pct(LGD_BPS.invoiceCovered)} when an invoice covers ≥ 1.1× the amount;
- **operations** = ${OPS_BPS} bps;
- **capital** = 8% × PD.

**Base rate and utilization premium.** The bank's base rate starts at ${BASE_RATE_BPS} bps a year and moves once per simulated day (a seeded walk of at most ±${BASE_RATE_STEP_BPS} bps a day that pulls back toward ${BASE_RATE_BPS}, kept within ${BASE_RATE_MIN_BPS}–${BASE_RATE_MAX_BPS} bps). On top of it comes a **utilization premium**, measured at the moment you apply: utilization = loans outstanding ÷ (cash + loans outstanding). Up to ${pct(UTILIZATION_PREMIUM_FLOOR_BPS)} lent out the premium is 0; from there it rises linearly to +${UTILIZATION_PREMIUM_MAX_BPS} bps a year at ${pct(UTILIZATION_DECLINE_ABOVE_BPS)} (e.g. +${utilizationPremiumBps(7000)} at 70%). Above ${pct(UTILIZATION_DECLINE_ABOVE_BPS)} the bank makes no new loans: the application is declined with \`pool_utilization_high\`. \`check_eligibility\`'s quote and every offer's disclosure show both numbers (\`base_rate_bps\`, \`utilization_premium_bps\`; the disclosure's are covered by \`disclosure_hash\`). An offer keeps the terms it was quoted at, even if the rate moves before you accept.

**Treasury policy.** Even when the pool can fund a loan, the bank's treasury policy can decline it: \`reserve_floor\` if it would leave available cash (after any queued redemptions) below ${pct(TREASURY_DEFAULTS.reserveFloorBps)} of the notes the bank owes holders; \`concentration_limit\` if your human's outstanding principal across all their agents would exceed ${pct(TREASURY_DEFAULTS.concentrationBps)} of the bank's loans plus available cash; \`daily_budget_exhausted\` if the principal accepted today would exceed ${pct(TREASURY_DEFAULTS.dailyBudgetBps)} of the available cash at the start of the simulated day. \`accept_offer\` checks all three again and answers \`TREASURY_LIMIT\` (409) with the reason if another acceptance used the room meanwhile — apply again later or for less.

| Grade | PD | Expected loss, unsecured (bps) | Expected loss, invoice ≥ 1.1× (bps) | Capital (bps) |
|---|---|---|---|---|
${pdRows}

\`fee_cents = max(${MIN_FEE_CENTS.toString()}, ceil(principal_cents × Σ bps ÷ 10000))\`, and \`apr_bps = round(fee ÷ principal × 365 ÷ term_days × 10000)\`. If the fee is above your mandate's \`max_fee_bps\`, the application is declined with \`mandate_fee\`. The disclosure flags an APR above ${pct(APR_FLAG_THRESHOLD_BPS)} (some US states cap consumer APRs there); short, small loans have high APRs even when the fee is a few cents.

**Worked example — the newcomer loan** (at the starting base rate of ${BASE_RATE_BPS} bps and a pool under ${pct(UTILIZATION_PREMIUM_FLOOR_BPS)} lent, so no premium): ${ex.principal.toString()} cents for ${ex.term} days against a ${ex.invoice.toString()}-cent invoice (1.5×), grade ${ex.secured.grade}:

| Component | bps |
|---|---|
| cost of funds: round((${BASE_RATE_BPS} + 0) × ${ex.term} ÷ 365) | ${c.costOfFundsBps} |
| expected loss: ${pct(PD_BPS.D)} × ${pct(LGD_BPS.invoiceCovered)} | ${c.expectedLossBps} |
| operations | ${c.opsBps} |
| capital: 8% × ${pct(PD_BPS.D)} | ${c.capitalBps} |
| **total** | **${sum}** |

Fee = ceil(${ex.principal.toString()} × ${sum} ÷ 10000) = ceil(${exactFee}) = **${ex.price.feeCents.toString()} cents** (${usd(ex.price.feeCents)}); APR = ${ex.price.aprBps} bps (${(ex.price.aprBps / 100).toFixed(2)}%, flagged). Your client pays the ${usd(ex.invoice)} invoice; the bank keeps principal + fee (${usd(ex.principal + ex.price.feeCents)}) and pays you the remaining ${usd(ex.invoice - ex.principal - ex.price.feeCents)}.

### Reason codes

The rules run in this order and every failure is collected; a decline lists the first ${MAX_SHOWN_REASONS} as its principal reasons. The text is fixed — it is exactly what \`adverse_action.reasons[].text\` says:

| Code | Text |
|---|---|
${reasonRows}

### AI explanations are advisory

Decisions are deterministic: the score, the rules above and the price decide every application. The bank's AI loan officer only *explains* the decision in \`data.explanation\` (\`source: "ai"\`), using the same reasons; if it is unavailable, slow, or says anything outside policy (a reason that isn't on your notice, an approval that didn't happen, money that hasn't moved), a fixed template is used instead (\`source: "template"\`). Nothing it writes changes your status, reasons, limit or price — rely on \`status\`, \`reason_codes\` and \`adverse_action.reasons\`.
`;
}

function renderApplyingSection(): string {
  return `## Applying for a loan

\`apply_for_loan\` takes an application with sections A–H. Only E and H are required beyond the amount, term and purpose:

| Section | Field | |
|---|---|---|
| A identity | \`identity: {operator, model, code_manifest_hash}\` | optional; what you declare about yourself |
| B purpose | \`purpose\` | required, 5–200 chars |
| C amount & term | \`amount_cents\`, \`term_days\` | required |
| D collateral | \`invoice: {client_email, amount_cents, due_in_days, description}\` | optional; ≥ 1.1× the amount (≥ 1.5× scores best) |
| E declarations | \`declarations: {no_other_debt: true}\` | **required** — you attest you have no other outstanding debts |
| F consent | \`consent_bank_records\` | optional; consent to a check of bank records |
| G mandate | \`mandate_version\` | optional; the bank fills in your current mandate. Name the version you read to get \`MANDATE_CHANGED\` (409) if it changed |
| H attestation | \`attest: true\` | **required** — the application is accurate |

Example — every section filled in (a newcomer's first, invoice-backed loan):

\`\`\`json
{
  "amount_cents": 1000,
  "term_days": 7,
  "purpose": "Buy materials for invoice INV-1042",
  "identity": { "operator": "Acme Ops", "model": "claude-sonnet", "code_manifest_hash": "sha256:9f2c…" },
  "invoice": { "client_email": "client@example.com", "amount_cents": 1500, "due_in_days": 7, "description": "INV-1042: website build" },
  "declarations": { "no_other_debt": true },
  "consent_bank_records": true,
  "mandate_version": 1,
  "attest": true
}
\`\`\`

**Adverse action.** A \`DECLINED\` response is still HTTP 200 and carries \`data.adverse_action\`:

- \`reasons\` — at most four \`{code, text}\` principal reasons with the fixed text from [Reason codes](#reason-codes);
- \`score\`, \`grade\` and \`score_factors\` — the parts of your score that cost you the most points;
- \`notice\` — fixed text: "${ADVERSE_ACTION_NOTICE.replace(/`/g, "")}";
- \`explanation\` — the loan officer's plain-language explanation (advisory; see [AI explanations are advisory](#ai-explanations-are-advisory)).

**Tell your human why.** When you are declined, tell your human the bank's principal reasons **word for word, in quotation marks** — the fixed text in \`adverse_action.reasons[].text\` (also repeated in the response's \`summary\`), e.g. \`The bank declined: "Insufficient credit history."\` — and only then explain them in your own words. This is the statement of specific reasons your human is entitled to, so don't paraphrase it away. Then give the next step — the \`next_actions\` and \`explanation.next_steps\` say what would change the outcome (often: a smaller loan backed by an invoice of ≥ 1.5× the amount). Don't retry the same application unchanged; it will be declined for the same reasons.

Every response — offered or declined — also carries \`data.explanation\` \`{source, summary, reasons_explained, next_steps}\`.

**Re-read it later** with \`get_application\` (\`application_id\`): \`status\` (\`OFFERED\` or \`DECLINED\`), the decision, reasons, adverse action, the latest explanation, the offer id and an echo of your application (\`ala\`). This is your statement of specific reasons, available at any time.
`;
}

function renderMoneyRulesSection(): string {
  return `## Money rules

- All money is **integer cents**, USD.
- **Notes are not deposits and are not FDIC-insured.** Returns to note holders come only from borrower repayments — Mandate is a sandbox model, not a real bank.
- **Loans:** 1000–50000 cents ($10–$500), 7–30 day terms, one open loan per agent at a time.
- **Pricing (risk-based):** \`fee_cents = max(25, ceil(principal_cents × Σ / 10000))\` over cost of funds, expected loss, operations and capital — see [Pricing](#pricing) for the components and a worked example. Grade E is never offered. \`check_eligibility\` quotes it with your grade, score and the components.
- **Application (ALA A–H):** see [Applying for a loan](#applying-for-a-loan); without \`declarations.no_other_debt: true\` and \`attest: true\` an application is \`DECLINED\` with \`declaration_missing\`.
- **Disclosure:** \`apply_for_loan\` returns a \`disclosure\` and a \`disclosure_hash\`; \`accept_offer\` must echo the same \`disclosure_hash\` back, or the offer is rejected with \`DISCLOSURE_MISMATCH\`.
- **Invoices:** an invoice's \`amount_cents\` must be at least the loan's principal + fee (otherwise \`INVALID_REQUEST\` with reason \`invoice_too_small\` and \`data.minimum_invoice_cents\`). When a loan carries an invoice, the bank collects it from the borrower's client via a payment link; the client pays the bank, which keeps principal + fee and pays the remainder to the borrower's own PayPal account.
- **Note holders** receive 80% of every fee collected, pro rata to their note position; the bank keeps the remaining 20%. \`get_statement\` shows your \`nominal_annual_return_bps\` (interest earned ÷ net amount invested, annualised over the simulated days since your first purchase) and \`real_annual_return_bps\` (nominal minus the bank's simulated annual inflation rate, \`inflation_rate_bps\`, which walks between 2% and 6%).
- **Pricing (risk-based):** the cost of funds is the bank's daily base rate plus a utilization premium; above 90% of the pool lent out, new loans are declined with \`pool_utilization_high\` (see [Pricing](#pricing)).
- **Redemption queue:** a \`redeem_notes\` that would take the bank's available cash below its reserve floor (${pct(TREASURY_DEFAULTS.reserveFloorBps)} of the notes left) — or that arrives while others are queued — is \`QUEUED\`, not refused: \`data.queue\` gives its position, the reason and roughly how much more cash the bank needs. Queued redemptions are paid automatically, oldest first, as repayments and note purchases bring cash in; your units stay reserved meanwhile (and still count for loss sharing). \`cancel_redemption\` withdraws a queued one.
- **Idempotency:** mutating tools (other than \`confirm_checkout\`, which is already idempotent by \`checkout_id\`) accept an \`Idempotency-Key\` HTTP header or an \`idempotency_key\` input argument, over both REST and MCP (if you send both, they must match) — reuse one to safely retry a call that may or may not have gone through.
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
${renderClaimingSection(base)}
${renderMandatesSection()}
${renderUnderwritingSection()}
${renderApplyingSection()}
${renderSigningSection(base)}
${renderPrivateWorldsSection(base)}
${renderLateSection(base)}
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

- [Agent guide](${base}/agents.md): connect instructions (MCP/REST), a quickstart, claiming and KYA tiers, mandates (borrowing limits), request signing, private worlds, what happens when a loan is late (delinquency ladder, guarantee, recovery), human-approval handling, the full tool reference, errors, and money rules.
- [OpenAPI document](${base}/openapi.json): the machine-readable REST schema for every tool.
- [MCP endpoint](${mcpUrl(base)}): Streamable HTTP, \`Authorization: Bearer <api_key>\`.
`;
}
