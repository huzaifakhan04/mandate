import { describe, expect, it } from "vitest";

import { GET as agentsMdGet } from "@/app/agents.md/route";
import { GET as llmsTxtGet } from "@/app/llms.txt/route";
import { exampleForSchema, renderAgentsMd, renderLlmsTxt } from "@/server/contracts/docs";
import { knownStatusTable } from "@/server/contracts/envelope";
import { REASON_PRIORITY, REASON_TEXT } from "@/server/domain/reasons";
import { registry } from "@/server/contracts/registry";
import "@/server/contracts/tools";

const BASE_URL = "https://mandate.example.com";

describe("renderAgentsMd", () => {
  const statusTable = knownStatusTable();
  const md = renderAgentsMd(registry, BASE_URL, statusTable);

  it("contains every registered tool's name", () => {
    for (const tool of registry) {
      expect(md).toContain(tool.name);
    }
  });

  it("gives every tool an anchor matching its name, so docs_url (#<tool-name>) always resolves", () => {
    for (const tool of registry) {
      expect(md).toContain(`<a id="${tool.name}"></a>`);
    }
  });

  it("contains the MCP Streamable HTTP URL", () => {
    expect(md).toContain(`${BASE_URL}/api/mcp/mcp`);
  });

  it("documents connect instructions for Claude Code, Cursor, and Codex", () => {
    expect(md).toContain("claude mcp add --transport http mandate");
    expect(md).toContain("~/.cursor/mcp.json");
    expect(md).toContain("~/.codex/config.toml");
    expect(md).toContain("mcp_servers.mandate");
  });

  it("documents a curl example for register_agent and get_status", () => {
    expect(md).toContain(`curl -s -X POST ${BASE_URL}/api/v1/register_agent`);
    expect(md).toContain(`curl -s ${BASE_URL}/api/v1/get_status`);
  });

  it("documents the quickstart in order: register, buy_notes, check_eligibility, apply, accept, repay", () => {
    const order = ["register_agent", "buy_notes", "check_eligibility", "apply_for_loan", "accept_offer", "repay_loan"];
    let lastIndex = -1;
    for (const name of order) {
      const index = md.indexOf(name, lastIndex + 1);
      expect(index, `expected "${name}" to appear after the previous quickstart step`).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it("documents claiming and the KYA tiers (P2 Task 2)", () => {
    expect(md).toContain("## Claiming and KYA tiers");
    expect(md).toContain(`${BASE_URL}/claim/<token>`);
    expect(md).toContain("Ask your human to open <claim_url>");
    expect(md).toContain("`CLAIM_REQUIRED` (403)");
    expect(md).toContain("`MANDATE_REQUIRED` (403)");
    expect(md).toContain("per loan ≤ 25000 cents");
    expect(md).not.toContain("ALLOW_INSTANT_ACTIVATION");
  });

  it("explains human_approval's url/who/then shape", () => {
    expect(md).toContain("human_approval");
    expect(md).toContain('"who": "payer"');
    expect(md).toContain('"then"');
  });

  it("documents every known status code from envelope.ts's table", () => {
    for (const row of statusTable) {
      expect(md).toContain(`\`${row.status}\``);
      expect(md).toContain(`| ${row.http} |`);
    }
  });

  it("states the money rules: cents, loan range, term range, fee formula, not-FDIC-insured", () => {
    expect(md).toContain("1000–50000 cents");
    expect(md).toContain("7–30 day");
    expect(md).toContain("not FDIC-insured");
    expect(md).toContain("80%");
  });

  it("documents the ALA application A–H with an example, adverse action and get_application (P3 Task 4)", () => {
    expect(md).toContain("## Applying for a loan");
    for (const field of ["identity", "declarations", "no_other_debt", "consent_bank_records", "mandate_version", "attest"]) {
      expect(md).toContain(field);
    }
    expect(md).toContain('"attest": true');
    expect(md).toContain("adverse_action");
    expect(md).toContain("declaration_missing");
    expect(md).toContain("MANDATE_CHANGED");
    expect(md).toContain("### `get_application`");
  });

  it("documents scoring, grades and limits, the newcomer path, pricing v2 with the worked example (P3 Task 5)", () => {
    expect(md).toContain("## Credit score and underwriting");
    for (const component of ["Identity", "Repayment history", "Tenure", "Collateral", "Exposure"]) {
      expect(md).toContain(`| ${component} |`);
    }
    expect(md).toContain("| A | 80–100 | 50000 |");
    expect(md).toContain("| D | 35–49 | 10000 | auto-approved up to 5000 cents");
    expect(md).toContain("| E | 0–34 | 0 |");
    expect(md).toContain("### The newcomer path");
    expect(md).toMatch(/unsecured\*\* first loan scores 20 \(grade E\)/);
    expect(md).toContain("40, grade D");
    // The 1000/7d newcomer against a 1500 invoice: 8 + 420 + 50 + 96 = 574 bps → fee 58, remainder 442.
    expect(md).toContain("| **total** | **574** |");
    expect(md).toContain("**58 cents** ($0.58)");
    expect(md).toContain("remaining $4.42");
  });

  it("documents every reason code with its fixed text, adverse action and that AI explanations are advisory", () => {
    for (const code of REASON_PRIORITY) {
      expect(md).toContain(`| \`${code}\` | ${REASON_TEXT[code]} |`);
    }
    expect(md).toContain("### AI explanations are advisory");
    expect(md).toContain("Decisions are deterministic");
    expect(md).toContain("adverse_action.reasons[].text");
    expect(md).toContain("right to a statement of specific reasons");
    expect(md).toContain('"mandate_version": 1');
  });

  it("is deterministic for the same registry and base URL", () => {
    const again = renderAgentsMd(registry, BASE_URL, statusTable);
    expect(again).toBe(md);
  });

  it("includes a plausible example input for register_agent (spot check)", () => {
    expect(md).toContain('"name": "example"');
    expect(md).toContain('"payout_email": "agent@example.com"');
  });
});

describe("renderLlmsTxt", () => {
  const txt = renderLlmsTxt(BASE_URL);

  it("starts with an H1 and a summary blockquote", () => {
    expect(txt.startsWith("# Mandate")).toBe(true);
    expect(txt).toMatch(/\n> .+\n/);
  });

  it("links to /agents.md and /openapi.json", () => {
    expect(txt).toContain(`${BASE_URL}/agents.md`);
    expect(txt).toContain(`${BASE_URL}/openapi.json`);
  });
});

describe("exampleForSchema", () => {
  it("includes only required properties", () => {
    const example = exampleForSchema({
      type: "object",
      properties: {
        required_field: { type: "string" },
        optional_field: { type: "string" },
      },
      required: ["required_field"],
    });
    expect(example).toEqual({ required_field: "example" });
  });

  it("uses a declared minimum for numbers", () => {
    expect(exampleForSchema({ type: "integer", minimum: 1000 })).toBe(1000);
  });

  it("uses a format-appropriate placeholder for email and uuid strings", () => {
    expect(exampleForSchema({ type: "string", format: "email" })).toBe("agent@example.com");
    expect(exampleForSchema({ type: "string", format: "uuid" })).toBe("11111111-1111-1111-1111-111111111111");
  });
});

describe("every registered tool's description", () => {
  it("is at least 80 characters (what it does, when to call it, what's next)", () => {
    for (const tool of registry) {
      expect(tool.description.length, `${tool.name}: "${tool.description}"`).toBeGreaterThanOrEqual(80);
    }
  });
});

describe("GET /agents.md route", () => {
  it("returns text/markdown with a 5-minute public cache and every tool name", async () => {
    const res = await agentsMdGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = await res.text();
    for (const tool of registry) {
      expect(body).toContain(tool.name);
    }
  });
});

describe("GET /llms.txt route", () => {
  it("returns text/plain with a 5-minute public cache and links that resolve to existing routes", async () => {
    const res = await llmsTxtGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = await res.text();
    expect(body).toMatch(/\/agents\.md/);
    expect(body).toMatch(/\/openapi\.json/);
  });
});

describe("agents.md signing section (P2 Task 3)", () => {
  it("documents the signing headers, the canonical string, the 401 statuses and a runnable Node example", async () => {
    const { renderAgentsMd } = await import("@/server/contracts/docs");
    const { knownStatusTable } = await import("@/server/contracts/envelope");
    const { registry } = await import("@/server/contracts/registry");
    await import("@/server/contracts/tools");
    const md = renderAgentsMd(registry, "https://mandate.example", knownStatusTable());
    const section = md.slice(md.indexOf("## Signing requests (optional, unlocks tier T2)"), md.indexOf("## Human approval"));
    expect(section.length).toBeGreaterThan(100);
    for (const text of ["X-Mandate-Timestamp", "X-Mandate-Signature", "X-Mandate-Previous-Signature", "register_public_key", "SIGNATURE_REPLAYED", 'generateKeyPairSync("ed25519")']) {
      expect(section).toContain(text);
    }
    expect(section).toContain("${timestamp}\\n${METHOD}\\n${path}\\n${sha256hex(body)}");
    expect(section).toContain("const path = `/api/v1/${tool}`;");
    expect(section).toContain("Buffer.from(`${timestamp}\\nPOST\\n${path}\\n${digest}`)");
    expect(section).toContain("fetch(`https://mandate.example${path}`");
    expect(md).toMatch(/\| `SIGNATURE_REQUIRED` \| 401 \|/);
  });
});

describe("agents.md mandates section (P2 Task 4)", () => {
  it("documents what the human sets, what the agent sees, every reason code and the accept-time statuses", async () => {
    const { renderAgentsMd } = await import("@/server/contracts/docs");
    const { knownStatusTable } = await import("@/server/contracts/envelope");
    const { registry } = await import("@/server/contracts/registry");
    await import("@/server/contracts/tools");
    const md = renderAgentsMd(registry, "https://mandate.example", knownStatusTable());
    const section = md.slice(md.indexOf("## Mandates"), md.indexOf("## Signing requests"));
    expect(section.length).toBeGreaterThan(100);
    for (const text of [
      "max_per_loan_cents",
      "max_total_owed_cents",
      "max_fee_bps",
      "max_term_days",
      "eligible_collateral",
      "expires_at",
      "total_owed_headroom_cents",
      "mandate_version",
      "mandate_missing",
      "mandate_per_loan",
      "mandate_total_owed",
      "mandate_fee",
      "mandate_term",
      "mandate_collateral",
      "tier_per_loan",
      "`MANDATE_REVOKED` (409)",
      "`MANDATE_LIMIT` (400)",
      "mandate_superseded",
    ]) {
      expect(section).toContain(text);
    }
    expect(md).toContain("| `MANDATE_REVOKED` | 409 |");
  });
});

describe("agents.md identity sections (P2 Task 7)", () => {
  const md = renderAgentsMd(registry, BASE_URL, knownStatusTable());

  it("explains what unlocks each tier and the human claim flow (send your human the claim_url)", () => {
    const section = md.slice(md.indexOf("## Claiming and KYA tiers"), md.indexOf("## Mandates"));
    for (const text of [
      "| T0 | unclaimed |",
      "| T1 | claimed by a PayPal-verified human **and** a signed mandate |",
      "| T2 | T1 + an approved KYA document + a registered Ed25519 key",
      "**T0 → T1**",
      "**T1 → T2**",
      "send your human the `claim_url`",
      "**Verify with PayPal**",
      "**Claim agent**",
      `${BASE_URL}/dashboard`,
      "`claim_required` → `mandate_missing` → empty",
    ]) {
      expect(section).toContain(text);
    }
  });

  it("documents Ruling P2-D: mandate expiry is real calendar time, offers run on the simulated clock", () => {
    const section = md.slice(md.indexOf("## Mandates"), md.indexOf("## Signing requests"));
    expect(section).toContain("**Two clocks.**");
    expect(section).toContain("`expires_at` is **real calendar time**");
    expect(section).toContain("an offer's expiry");
    expect(section).toContain("**simulated clock**");
  });

  it("documents what happens when a loan is late (P4): ladder, amounts, waterfall, quotes and waiver, charge-off, guarantee, recovery, notices", () => {
    expect(md).toContain("## When you're late");
    for (const step of ["`late`", "`penalty`", "`substandard`", "`charged_off`", "`recovered`"]) {
      expect(md).toContain(step);
    }
    for (const day of ["| +1 |", "| +3 |", "| +7 |", "| +10 |"]) {
      expect(md).toContain(day);
    }
    expect(md).toContain("min(500, max(100, 5% × outstanding principal))");
    expect(md).toContain("ceil(outstanding principal × 200 × days_late / (10000 × 365))");
    expect(md).toContain("late fees → rate penalty → fee → principal → remainder");
    expect(md).toContain("waived");
    expect(md).toContain("`MANDATE_FROZEN` (409)");
    expect(md).toContain("`delinquent_principal`");
    expect(md).toContain("guarantee is invoked");
    expect(md).toContain("`RECOVERED`");
    expect(md).toContain("`ack_notices`");
    expect(md).toContain("`data.notices`");
    expect(md).toContain("tell your human what it means for them");
    // Ruling P4-G: collection is by payment link, no auto-debit.
    expect(md).toContain("never debits anyone automatically");
    expect(md.indexOf("## Private worlds")).toBeLessThan(md.indexOf("## When you're late"));
  });

  it("P7: documents repayment plans — the rules, the tick's re-planning table, where the plan shows", () => {
    const section = md.slice(md.indexOf("## Repayment plans"), md.indexOf("## The bank's economy"));
    expect(md.indexOf("## When you're late")).toBeLessThan(md.indexOf("## Repayment plans"));
    for (const text of [
      "`plan_repayments`",
      "`reschedule_installment`",
      "1 to 4 installments",
      "at least **1 sim day ahead**",
      "at most **2 times**",
      "`auto_reschedule: true`",
      "`PLAN_EXISTS` (409)",
      "`INVALID_PLAN` (400)",
      "`amounts_do_not_sum`",
      "`installment_missed`",
      "`installment_failed`",
      "refunded or reversed",
      "`data.repayment_plan`",
      "never changes what you owe",
    ]) {
      expect(section).toContain(text);
    }
  });

  it("P5: documents the economy — base rate, inflation, utilization premium, treasury gates + reason codes, the queue, stress scenarios", () => {
    const section = md.slice(md.indexOf("## The bank's economy"), md.indexOf("## Human approval"));
    expect(md.indexOf("## When you're late")).toBeLessThan(md.indexOf("## The bank's economy"));
    for (const text of [
      "**Base rate:** starts at 400 bps",
      "real_annual_return_bps",
      "**Utilization premium:**",
      "`pool_utilization_high`",
      "| `reserve_floor` |",
      "| `concentration_limit` |",
      "| `daily_budget_exhausted` |",
      "`TREASURY_LIMIT` (409)",
      "`QUEUED`",
      "oldest first",
      "`cancel_redemption` (`note_tx_id`",
      "gross of note-holder loss sharing",
      "**Default wave:**",
      "**Note run:**",
      "**Rate spike:** the base rate jumps +500 bps",
      "can't be triggered in the main world",
    ]) {
      expect(section).toContain(text);
    }
  });

  it("documents private worlds: what they are, how a human creates one, keys bound to a world", () => {
    const section = md.slice(md.indexOf("## Private worlds"), md.indexOf("## Human approval"));
    expect(section.length).toBeGreaterThan(200);
    for (const text of [
      "simulated money only",
      `${BASE_URL}/dashboard/worlds`,
      "up to 3",
      "four lender bots and six borrower bots",
      "**+1 day** or **+7 days**",
      "**bound to that world**",
      `${BASE_URL}/dashboard/agents/new`,
    ]) {
      expect(section).toContain(text);
    }
    expect(renderLlmsTxt(BASE_URL)).toContain("private worlds");
  });
});
