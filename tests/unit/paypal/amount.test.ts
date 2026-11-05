import { describe, expect, it } from "vitest";

import {
  InvalidAmountError,
  amountToCents,
  assertPositiveAmountCents,
  centsToAmount,
} from "@/server/paypal/orders";

describe("centsToAmount / amountToCents", () => {
  const cases: [bigint, string][] = [
    [1n, "0.01"],
    [100n, "1.00"],
    [150n, "1.50"],
    [123456789n, "1234567.89"],
    [-100n, "-1.00"],
  ];

  it.each(cases)("centsToAmount(%s) === %s", (cents, amount) => {
    expect(centsToAmount(cents)).toBe(amount);
  });

  it.each(cases)("amountToCents(%s) === %s", (cents, amount) => {
    expect(amountToCents(amount)).toBe(cents);
  });

  it("round-trips 1 and 1.5 the same as 1.00/1.50", () => {
    expect(amountToCents("1")).toBe(100n);
    expect(amountToCents("1.5")).toBe(150n);
  });

  it("rejects more than 2 fraction digits", () => {
    expect(() => amountToCents("1.505")).toThrow(InvalidAmountError);
  });

  it("rejects a malformed amount string", () => {
    expect(() => amountToCents("abc")).toThrow(InvalidAmountError);
  });
});

describe("assertPositiveAmountCents", () => {
  it("accepts a positive amount", () => {
    expect(() => assertPositiveAmountCents(1n)).not.toThrow();
  });

  it("rejects zero", () => {
    expect(() => assertPositiveAmountCents(0n)).toThrow(InvalidAmountError);
  });

  it("rejects a negative amount", () => {
    expect(() => assertPositiveAmountCents(-1n)).toThrow(InvalidAmountError);
  });
});
