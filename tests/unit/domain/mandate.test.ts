import { describe, expect, it } from "vitest";

import {
  checkMandate,
  effectivePerLoanCap,
  mandateTermsHash,
  parseMandateSignInput,
  totalOwedHeadroom,
  type MandateLimits,
  type MandateOffer,
} from "@/server/domain/mandate";

const NOW = new Date("2026-11-06T12:00:00Z");

const limits: MandateLimits = {
  maxPerLoanCents: 20000n,
  maxTotalOwedCents: 30000n,
  maxFeeBps: 500,
  maxTermDays: 14,
  eligibleCollateral: ["none"],
};

// 10000 for 14 days: fee 300 (= 300 bps of P).
const fits: MandateOffer = { principalCents: 10000n, feeCents: 300n, termDays: 14, collateral: "none" };

describe("checkMandate", () => {
  it("an offer within every limit passes", () => {
    expect(checkMandate(limits, 0n, fits)).toEqual([]);
  });

  it("no mandate → mandate_missing", () => {
    expect(checkMandate(null, 0n, fits)).toEqual(["mandate_missing"]);
  });

  it("mandate_per_loan: principal above max_per_loan (equal is fine)", () => {
    expect(checkMandate(limits, 0n, { ...fits, principalCents: 20000n, feeCents: 600n })).toEqual([]);
    expect(checkMandate(limits, 0n, { ...fits, principalCents: 20001n, feeCents: 600n })).toEqual(["mandate_per_loan"]);
  });

  it("mandate_total_owed: exposure + P + F above max_total_owed (equal is fine)", () => {
    expect(checkMandate(limits, 19700n, fits)).toEqual([]);
    expect(checkMandate(limits, 19701n, fits)).toEqual(["mandate_total_owed"]);
  });

  it("mandate_fee: fee above max_fee_bps of the principal (equal is fine)", () => {
    expect(checkMandate({ ...limits, maxFeeBps: 300 }, 0n, fits)).toEqual([]);
    expect(checkMandate({ ...limits, maxFeeBps: 299 }, 0n, fits)).toEqual(["mandate_fee"]);
  });

  it("mandate_term: term above max_term_days", () => {
    expect(checkMandate(limits, 0n, { ...fits, termDays: 15 })).toEqual(["mandate_term"]);
  });

  it("mandate_collateral: collateral kind not eligible", () => {
    expect(checkMandate(limits, 0n, { ...fits, collateral: "invoice_link" })).toEqual(["mandate_collateral"]);
    expect(
      checkMandate({ ...limits, eligibleCollateral: ["invoice_link", "none"] }, 0n, { ...fits, collateral: "invoice_link" }),
    ).toEqual([]);
  });

  it("reports every broken limit, in a fixed order", () => {
    const tight: MandateLimits = { ...limits, maxPerLoanCents: 1000n, maxTotalOwedCents: 1000n, maxFeeBps: 0, maxTermDays: 7 };
    expect(checkMandate(tight, 0n, { ...fits, collateral: "invoice_link" })).toEqual([
      "mandate_per_loan",
      "mandate_total_owed",
      "mandate_fee",
      "mandate_term",
      "mandate_collateral",
    ]);
  });
});

describe("headroom and caps", () => {
  it("total owed headroom never goes negative", () => {
    expect(totalOwedHeadroom(limits, 10000n)).toBe(20000n);
    expect(totalOwedHeadroom(limits, 40000n)).toBe(0n);
  });

  it("per-loan cap is min(tier cap, mandate max_per_loan)", () => {
    expect(effectivePerLoanCap(25000, limits)).toBe(20000n);
    expect(effectivePerLoanCap(25000, { ...limits, maxPerLoanCents: 50000n })).toBe(25000n);
    expect(effectivePerLoanCap(50000, { ...limits, maxPerLoanCents: 50000n })).toBe(50000n);
    expect(effectivePerLoanCap(25000, null)).toBe(0n);
  });
});

describe("parseMandateSignInput", () => {
  const valid = {
    max_per_loan_cents: 20000,
    max_total_owed_cents: "30000",
    max_fee_bps: "500",
    max_term_days: 14,
    eligible_collateral: "none,invoice_link",
    typed_name: "  Ada   Lovelace ",
    agree: "on",
  };

  it("accepts JSON numbers or form strings and normalises", () => {
    const parsed = parseMandateSignInput(valid, NOW);
    expect(parsed).toEqual({
      ok: true,
      signerName: "Ada Lovelace",
      terms: {
        maxPerLoanCents: 20000n,
        maxTotalOwedCents: 30000n,
        maxFeeBps: 500,
        maxTermDays: 14,
        eligibleCollateral: ["invoice_link", "none"],
        expiresAt: null,
      },
    });
  });

  it("rejects out-of-range limits, bad collateral, a past expiry, no name and no checkbox", () => {
    const parsed = parseMandateSignInput(
      {
        max_per_loan_cents: 999,
        max_total_owed_cents: -1,
        max_fee_bps: 10001,
        max_term_days: 0,
        eligible_collateral: ["crypto"],
        expires_at: "2026-11-01",
        typed_name: "A",
        agree: "",
      },
      NOW,
    );
    expect(parsed).toEqual({
      ok: false,
      errors: [
        "max_per_loan_cents",
        "max_total_owed_cents",
        "max_fee_bps",
        "max_term_days",
        "eligible_collateral",
        "expires_at",
        "typed_name",
        "agree",
      ],
    });
  });

  it("a future expiry is kept", () => {
    const parsed = parseMandateSignInput({ ...valid, expires_at: "2026-12-31T00:00:00Z" }, NOW);
    expect(parsed.ok && parsed.terms.expiresAt?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });
});

describe("mandateTermsHash", () => {
  const record = {
    worldId: "w",
    agentId: "a",
    principalId: "p",
    version: 1,
    terms: { ...limits, expiresAt: null },
    signerName: "Ada Lovelace",
    signedAt: NOW,
    guaranteeTextHash: "g",
  };

  it("is stable and changes with any signed field", () => {
    expect(mandateTermsHash(record)).toMatch(/^[0-9a-f]{64}$/);
    expect(mandateTermsHash({ ...record })).toBe(mandateTermsHash(record));
    expect(mandateTermsHash({ ...record, version: 2 })).not.toBe(mandateTermsHash(record));
    expect(mandateTermsHash({ ...record, terms: { ...record.terms, maxFeeBps: 501 } })).not.toBe(mandateTermsHash(record));
  });
});
