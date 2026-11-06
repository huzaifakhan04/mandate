import { describe, expect, it } from "vitest";

import { distribute } from "@/server/domain/distribution";

describe("distribute (pro rata, largest remainder)", () => {
  it("golden: units [3,3,3], amount 10 → [4,3,3]; the first agentId (stable sort) gets the extra cent", () => {
    const result = distribute(
      [
        { agentId: "c", units: 3n },
        { agentId: "a", units: 3n },
        { agentId: "b", units: 3n },
      ],
      10n,
    );
    expect(result).toEqual([
      { agentId: "a", cents: 4n },
      { agentId: "b", cents: 3n },
      { agentId: "c", cents: 3n },
    ]);
  });

  it("a single holder gets everything", () => {
    expect(distribute([{ agentId: "only", units: 30000n }], 600n)).toEqual([{ agentId: "only", cents: 600n }]);
  });

  it("a 1-cent amount goes to one holder", () => {
    const result = distribute(
      [
        { agentId: "a", units: 1n },
        { agentId: "b", units: 1n },
      ],
      1n,
    );
    expect(result).toEqual([
      { agentId: "a", cents: 1n },
      { agentId: "b", cents: 0n },
    ]);
  });

  it("largest fractional remainder wins before agentId order", () => {
    // 2:1 split of 10 → 6.67 / 3.33 → base 6/3, remainder 1 goes to the larger fraction (a: .67).
    expect(
      distribute(
        [
          { agentId: "b", units: 1n },
          { agentId: "a", units: 2n },
        ],
        10n,
      ),
    ).toEqual([
      { agentId: "a", cents: 7n },
      { agentId: "b", cents: 3n },
    ]);
    // Same but the smaller holder sorts first: still the larger fraction wins.
    expect(
      distribute(
        [
          { agentId: "a", units: 1n },
          { agentId: "b", units: 2n },
        ],
        10n,
      ),
    ).toEqual([
      { agentId: "a", cents: 3n },
      { agentId: "b", cents: 7n },
    ]);
  });

  it("golden: 20000/10000 units sharing 600 → 400/200", () => {
    expect(
      distribute(
        [
          { agentId: "x", units: 20000n },
          { agentId: "y", units: 10000n },
        ],
        600n,
      ),
    ).toEqual([
      { agentId: "x", cents: 400n },
      { agentId: "y", cents: 200n },
    ]);
  });

  it("ignores zero-unit holders; no holders → empty", () => {
    expect(distribute([{ agentId: "a", units: 0n }], 10n)).toEqual([]);
    expect(distribute([], 10n)).toEqual([]);
    expect(
      distribute(
        [
          { agentId: "a", units: 0n },
          { agentId: "b", units: 5n },
        ],
        10n,
      ),
    ).toEqual([{ agentId: "b", cents: 10n }]);
  });

  it("always sums to the amount", () => {
    const holders = [
      { agentId: "a", units: 7n },
      { agentId: "b", units: 13n },
      { agentId: "c", units: 1n },
      { agentId: "d", units: 999n },
    ];
    for (const amount of [0n, 1n, 2n, 3n, 17n, 600n, 12345n]) {
      const result = distribute(holders, amount);
      expect(result.reduce((s, r) => s + r.cents, 0n)).toBe(amount);
    }
  });

  it("rejects a negative amount or negative units", () => {
    expect(() => distribute([{ agentId: "a", units: 1n }], -1n)).toThrow();
    expect(() => distribute([{ agentId: "a", units: -1n }], 1n)).toThrow();
  });
});
