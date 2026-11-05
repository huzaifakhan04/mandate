import { describe, expect, it } from "vitest";

import { buildOpenApiDocument, registry } from "@/server/contracts/registry";
import "@/server/contracts/tools";

describe("contract registry", () => {
  it("has at least one registered tool", () => {
    expect(registry.length).toBeGreaterThan(0);
  });

  it("has unique snake_case tool names", () => {
    const names = registry.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("requires every tool to have a description of at least 40 characters", () => {
    for (const tool of registry) {
      expect(tool.description.length).toBeGreaterThanOrEqual(40);
    }
  });

  it("includes get_bank_guide", () => {
    const names = registry.map((tool) => tool.name);
    expect(names).toContain("get_bank_guide");
  });

  it("generates an OpenAPI document that includes /api/v1/get_bank_guide", () => {
    const doc = buildOpenApiDocument();
    const paths = doc.paths as Record<string, unknown>;
    expect(paths).toHaveProperty("/api/v1/get_bank_guide");
    expect(doc.openapi).toBe("3.1.0");
  });
});
