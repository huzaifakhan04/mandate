import { readFileSync } from "fs";
import { resolve } from "path";

import { describe, expect, it } from "vitest";

import { registry } from "@/server/contracts/registry";
import { TOOL_GROUPS } from "@/server/contracts/toolMeta";
import "@/server/contracts/tools";
import {
  buildPostmanCollection,
  buildPostmanEnvironment,
  POSTMAN_SCHEMA,
  withVariables,
} from "@/server/sponsors/postmanCollection";

const BASE = "https://mandate-bank.onrender.com";

describe("Postman collection (P7)", () => {
  const collection = buildPostmanCollection(registry, { baseUrl: `${BASE}/` });
  const requests = collection.item.flatMap((folder) => folder.item);

  it("is a v2.1 collection with the six folders in order", () => {
    expect(collection.info.schema).toBe(POSTMAN_SCHEMA);
    expect(collection.item.map((folder) => folder.name)).toEqual([...TOOL_GROUPS]);
    expect(collection.item[0]!.item.slice(0, 2).map((i) => i.name)).toEqual(["get_bank_guide", "register_agent"]);
  });

  it("has a request for every registered tool, against {{baseUrl}}", () => {
    for (const tool of registry) {
      const item = requests.find((r) => r.name === tool.name);
      expect(item, tool.name).toBeDefined();
      expect(item!.request.url.raw).toBe(`{{baseUrl}}/api/v1/${tool.name}`);
      expect(() => JSON.parse(item!.request.body.raw)).not.toThrow();
    }
  });

  it("declares baseUrl and apiKey variables and the auth/test scripts", () => {
    const vars = Object.fromEntries(collection.variable.map((v) => [v.key, v.value]));
    expect(vars.baseUrl).toBe(BASE);
    expect(vars.apiKey).toBe("");
    const pre = collection.event.find((e) => e.listen === "prerequest")!.script.exec.join("\n");
    expect(pre).toContain("'Bearer ' + key");
    expect(pre).toContain('"register_agent"');
    const test = collection.event.find((e) => e.listen === "test")!.script.exec.join("\n");
    expect(test).toContain("'status', 'summary', 'reason_codes', 'data', 'next_actions', 'docs_url'");
    expect(test).toContain("pm.collectionVariables.set('apiKey', payload.api_key)");
  });

  it("uses the ALA example (declarations + attest) and {{variables}} for ids", () => {
    const apply = JSON.parse(requests.find((r) => r.name === "apply_for_loan")!.request.body.raw);
    expect(apply).toMatchObject({ declarations: { no_other_debt: true }, attest: true });
    const accept = JSON.parse(requests.find((r) => r.name === "accept_offer")!.request.body.raw);
    expect(accept).toEqual({ offer_id: "{{offer_id}}", disclosure_hash: "{{disclosure_hash}}" });
    expect(withVariables({ a: [1, "x"] })).toEqual({ a: [1, "x"] });
  });

  it("matches the committed copy served at /postman/collection.json", () => {
    const committed = JSON.parse(
      readFileSync(resolve("docs/sponsors/postman/mandate.postman_collection.json"), "utf8"),
    ) as { item: { name: string; item: { name: string }[] }[] };
    expect(committed.item.map((f) => [f.name, f.item.map((i) => i.name)])).toEqual(
      collection.item.map((f) => [f.name, f.item.map((i) => i.name)]),
    );
  });

  it("builds the Mandate prod environment with a secret apiKey", () => {
    const env = buildPostmanEnvironment(BASE);
    expect(env.name).toBe("Mandate prod");
    expect(env.values.find((v) => v.key === "apiKey")!.type).toBe("secret");
  });
});
