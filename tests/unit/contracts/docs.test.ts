import { describe, expect, it } from "vitest";

import { GET as agentsMdGet } from "@/app/agents.md/route";
import { GET as llmsTxtGet } from "@/app/llms.txt/route";
import { exampleForSchema, renderAgentsMd, renderLlmsTxt } from "@/server/contracts/docs";
import { knownStatusTable } from "@/server/contracts/envelope";
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
