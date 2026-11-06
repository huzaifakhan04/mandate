import { describe, expect, it } from "vitest";

import { buildOpenApiDocument, registry } from "@/server/contracts/registry";
import { describeWithExample, TOOL_GROUPS, toolExamples, toolGroup, toolHints, toolMetaEntry } from "@/server/contracts/toolMeta";
import "@/server/contracts/tools";

describe("tool metadata (P7 agent DX)", () => {
  it("has an entry with at least one example for every registered tool", () => {
    for (const tool of registry) {
      expect(toolMetaEntry(tool.name), tool.name).toBeDefined();
      expect(toolExamples(tool).length, tool.name).toBeGreaterThan(0);
    }
  });

  it("every example passes its tool's input schema as-is", () => {
    for (const tool of registry) {
      for (const example of toolExamples(tool)) {
        const parsed = tool.input.safeParse(example.args);
        expect(parsed.success, `${tool.name}: ${example.summary}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      }
    }
  });

  it("the apply_for_loan example carries the required ALA declarations and attestation", () => {
    const apply = registry.find((tool) => tool.name === "apply_for_loan")!;
    const [example] = toolExamples(apply);
    expect(example!.args).toMatchObject({ declarations: { no_other_debt: true }, attest: true });
  });

  it("derives hints consistent with the registry flags", () => {
    for (const tool of registry) {
      const hints = toolHints(tool);
      expect(hints.readOnlyHint, tool.name).toBe(tool.readOnly);
      if (tool.readOnly) {
        expect(hints.destructiveHint, tool.name).toBe(false);
        expect(hints.idempotentHint, tool.name).toBe(true);
      }
    }
    const byName = (name: string) => toolHints(registry.find((tool) => tool.name === name)!);
    expect(byName("accept_offer")).toMatchObject({ destructiveHint: true, openWorldHint: true });
    expect(byName("confirm_checkout")).toMatchObject({ idempotentHint: true, openWorldHint: true });
    expect(byName("buy_notes")).toMatchObject({ destructiveHint: false, idempotentHint: false, openWorldHint: true });
  });

  it("assigns every tool to a known group and covers every group", () => {
    const groups = new Set(registry.map((tool) => toolGroup(tool)));
    for (const group of groups) {
      expect(TOOL_GROUPS).toContain(group);
    }
    expect([...groups].sort()).toEqual([...TOOL_GROUPS].sort());
  });

  it("appends one compact example to the MCP description", () => {
    const tool = registry.find((t) => t.name === "check_eligibility")!;
    const text = describeWithExample(tool);
    expect(text.startsWith(tool.description)).toBe(true);
    expect(text).toContain('Example (');
    expect(text).toContain('{"amount_cents":1000,"term_days":7');
  });

  it("puts examples, tags and bearer security in the OpenAPI document", () => {
    const doc = buildOpenApiDocument("https://bank.example/");
    expect(doc.servers).toMatchObject([{ url: "https://bank.example" }]);
    const paths = doc.paths as Record<string, { post: Record<string, unknown> }>;
    const apply = paths["/api/v1/apply_for_loan"]!.post;
    expect(apply.tags).toEqual(["Borrow"]);
    expect(apply.security).toEqual([{ bearerAuth: [] }]);
    const content = (apply.requestBody as { content: Record<string, { examples: Record<string, { value: unknown }> }> })
      .content["application/json"]!;
    expect(content.examples.default!.value).toMatchObject({ attest: true });
    expect(paths["/api/v1/register_agent"]!.post.security).toEqual([]);
  });
});
