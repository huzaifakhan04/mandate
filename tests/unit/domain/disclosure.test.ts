import { createHash } from "crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson, disclosureHash } from "@/server/domain/disclosure";

describe("disclosure hashing", () => {
  it("canonical JSON sorts keys recursively and has no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("the hash is sha256 hex of the canonical JSON, independent of key order", () => {
    const a = { fee_cents: 750, term_days: 14 };
    const b = { term_days: 14, fee_cents: 750 };
    const expected = createHash("sha256").update('{"fee_cents":750,"term_days":14}').digest("hex");
    expect(disclosureHash(a)).toBe(expected);
    expect(disclosureHash(b)).toBe(expected);
  });
});
