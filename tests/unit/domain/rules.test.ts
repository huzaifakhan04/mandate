import { describe, expect, it } from "vitest";

import type { MandateLimits } from "@/server/domain/mandate";
import { MAX_SHOWN_REASONS, REASON_PRIORITY, REASON_TEXT, principalReasons } from "@/server/domain/reasons";
import {
  DEFAULT_SANCTIONS_STUB,
  evaluateApplication,
  sanctionsHit,
  sanctionsStubList,
  type ApplicationFacts,
} from "@/server/domain/rules";
import type { Grade, ScoreComponents } from "@/server/domain/scorecard";

const MANDATE: MandateLimits = {
  maxPerLoanCents: 50000n,
  maxTotalOwedCents: 1_000_000n,
  maxFeeBps: 10_000,
  maxTermDays: 365,
  eligibleCollateral: ["invoice_link", "none"],
};

const COMPONENTS: ScoreComponents = { identity: 25, history: 35, tenure: 10, collateral: 0, exposure: 10 };

function credit(grade: Grade, overrides: Partial<ScoreComponents> = {}) {
  const score = { A: 90, B: 70, C: 55, D: 40, E: 20 }[grade];
  return { score, grade, components: { ...COMPONENTS, ...overrides } };
}

function facts(overrides: Partial<ApplicationFacts> = {}): ApplicationFacts {
  return {
    amountCents: 10000n,
    termDays: 14,
    purpose: "Working capital",
    credit: credit("B"),
    tierCapCents: 50000n,
    mandate: MANDATE,
    exposureCents: 0n,
    collateral: "none",
    invoiceCoverageBps: null,
    sanctions: { name: "Acme Agent", operator: "acme-ops", list: sanctionsStubList(DEFAULT_SANCTIONS_STUB) },
    declarations: { noOtherDebt: true },
    openLoanExists: false,
    availableLiquidityCents: 1_000_000n,
    ...overrides,
  };
}

describe("evaluateApplication (rules pipeline)", () => {
  it("golden (10000, 14, B, unsecured) → approve, auto, fee 269, cap = B limit 30000", () => {
    const decision = evaluateApplication(facts());
    expect(decision).toMatchObject({
      decision: "approve",
      reasons: [],
      primary: null,
      effectiveCapCents: 30000n,
      approval: "auto",
    });
    expect(decision.price?.feeCents).toBe(269n);
  });

  it("golden (10000, 14, B, invoice 1.5×) → approve, fee 194", () => {
    const decision = evaluateApplication(
      facts({ collateral: "invoice_link", invoiceCoverageBps: 15000, credit: credit("B", { collateral: 20 }) }),
    );
    expect(decision).toMatchObject({ decision: "approve", reasons: [], approval: "auto" });
    expect(decision.price?.feeCents).toBe(194n);
  });

  it("golden (1000, 7, A, invoice) → approve at the 25-cent minimum fee", () => {
    const decision = evaluateApplication(
      facts({ amountCents: 1000n, termDays: 7, credit: credit("A"), collateral: "invoice_link", invoiceCoverageBps: 15000 }),
    );
    expect(decision).toMatchObject({ decision: "approve", effectiveCapCents: 50000n });
    expect(decision.price).toMatchObject({ feeCents: 25n, aprBps: 13036, aprFlag: true });
  });

  it("golden (50000, 30, D, none) under a 500-bps fee cap → decline mandate_fee first (Review Focus 4)", () => {
    // Fee 4495 = 899 bps > 500; 50000 is also above the D limit 10000.
    const decision = evaluateApplication(
      facts({ amountCents: 50000n, termDays: 30, credit: credit("D"), mandate: { ...MANDATE, maxFeeBps: 500 } }),
    );
    expect(decision).toMatchObject({
      decision: "decline",
      reasons: ["mandate_fee", "amount_exceeds_limit"],
      primary: "mandate_fee",
      effectiveCapCents: 10000n,
      approval: "auto",
    });
    expect(decision.price?.feeCents).toBe(4495n);
  });

  it("golden: grade E with no history → insufficient_credit_history; with some history → score_too_low", () => {
    const fresh = evaluateApplication(facts({ credit: credit("E", { history: 0 }) }));
    expect(fresh).toMatchObject({
      decision: "decline",
      reasons: ["insufficient_credit_history"],
      primary: "insufficient_credit_history",
      effectiveCapCents: 0n,
      price: null,
    });
    const someHistory = evaluateApplication(facts({ credit: credit("E", { history: 7 }) }));
    expect(someHistory).toMatchObject({ decision: "decline", reasons: ["score_too_low"], price: null });
  });

  it("grade D: ≤ 5000 auto-approves; above 5000 (within the D limit) → manual_review_declined", () => {
    const small = evaluateApplication(facts({ amountCents: 5000n, credit: credit("D") }));
    expect(small).toMatchObject({ decision: "approve", approval: "auto" });
    const band = evaluateApplication(facts({ amountCents: 5001n, credit: credit("D") }));
    expect(band).toMatchObject({
      decision: "decline",
      reasons: ["manual_review_declined"],
      primary: "manual_review_declined",
      approval: "manual_review_declined",
    });
  });

  it("amount above the grade limit → amount_exceeds_limit; at the limit approves", () => {
    expect(evaluateApplication(facts({ amountCents: 20000n, credit: credit("C") })).decision).toBe("approve");
    expect(evaluateApplication(facts({ amountCents: 20001n, credit: credit("C") }))).toMatchObject({
      reasons: ["amount_exceeds_limit"],
      effectiveCapCents: 20000n,
    });
  });

  it("the effective cap is min(grade, tier, mandate) and the tier/mandate parts keep their own codes", () => {
    const tierBound = evaluateApplication(facts({ amountCents: 26000n, tierCapCents: 25000n, credit: credit("A") }));
    expect(tierBound).toMatchObject({ reasons: ["tier_per_loan"], effectiveCapCents: 25000n });
    const mandateBound = evaluateApplication(
      facts({ amountCents: 16000n, credit: credit("A"), mandate: { ...MANDATE, maxPerLoanCents: 15000n } }),
    );
    expect(mandateBound).toMatchObject({ reasons: ["mandate_per_loan"], effectiveCapCents: 15000n });
    expect(evaluateApplication(facts({ mandate: null }))).toMatchObject({
      reasons: ["mandate_missing"],
      effectiveCapCents: 0n,
    });
  });

  it("sanctions stub → sanctions_hit (name or operator, case-insensitive)", () => {
    const byName = evaluateApplication(
      facts({ sanctions: { name: "SANCTIONED bot", operator: "x", list: sanctionsStubList(undefined) } }),
    );
    expect(byName).toMatchObject({ decision: "decline", reasons: ["sanctions_hit"] });
    const byOperator = evaluateApplication(
      facts({ sanctions: { name: "ok", operator: "Blocked-Entity LLC", list: sanctionsStubList(undefined) } }),
    );
    expect(byOperator.reasons).toEqual(["sanctions_hit"]);
  });

  it("invoice coverage below 1.1× → insufficient_collateral (exactly 1.1× passes)", () => {
    expect(evaluateApplication(facts({ collateral: "invoice_link", invoiceCoverageBps: 10999 })).reasons).toEqual([
      "insufficient_collateral",
    ]);
    expect(evaluateApplication(facts({ collateral: "invoice_link", invoiceCoverageBps: 11000 })).decision).toBe(
      "approve",
    );
  });

  it("declarations: an empty purpose or no 'no other debt' attestation → declaration_missing", () => {
    expect(evaluateApplication(facts({ purpose: "   " })).reasons).toEqual(["declaration_missing"]);
    expect(evaluateApplication(facts({ declarations: { noOtherDebt: false } })).reasons).toEqual([
      "declaration_missing",
    ]);
  });

  it("collects every reason in the fixed pipeline order; the first decides", () => {
    const decision = evaluateApplication(
      facts({
        amountCents: 60000n,
        termDays: 40,
        tierCapCents: 25000n,
        credit: credit("E", { history: 0 }),
        mandate: { ...MANDATE, maxTermDays: 30, eligibleCollateral: ["invoice_link"] },
        collateral: "none",
        invoiceCoverageBps: 10000,
        sanctions: { name: "sanctioned", operator: "x", list: sanctionsStubList(undefined) },
        purpose: "",
        openLoanExists: true,
        availableLiquidityCents: 100n,
      }),
    );
    expect(decision.reasons).toEqual([
      "amount_out_of_range",
      "term_out_of_range",
      "tier_per_loan",
      "mandate_per_loan",
      "mandate_term",
      "mandate_collateral",
      "sanctions_hit",
      "insufficient_credit_history",
      "insufficient_collateral",
      "declaration_missing",
      "open_loan_exists",
      "insufficient_liquidity",
    ]);
    expect(decision.primary).toBe("amount_out_of_range");
    // Pipeline order = notice priority order.
    const order = decision.reasons.map((code) => REASON_PRIORITY.indexOf(code));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("without a collateral kind the mandate collateral rule is skipped", () => {
    const decision = evaluateApplication(
      facts({ collateral: null, mandate: { ...MANDATE, eligibleCollateral: ["invoice_link"] } }),
    );
    expect(decision.decision).toBe("approve");
  });

  it("is deterministic", () => {
    const input = facts({ amountCents: 12345n, termDays: 19, credit: credit("C") });
    expect(evaluateApplication(input)).toEqual(evaluateApplication(input));
  });
});

describe("sanctions stub", () => {
  it("parses SANCTIONS_STUB: comma list, trimmed, lower-cased; unset → the default", () => {
    expect(sanctionsStubList(undefined)).toEqual(["sanctioned", "blocked-entity"]);
    expect(sanctionsStubList(" Evil Corp , ,BAD ")).toEqual(["evil corp", "bad"]);
    expect(sanctionsStubList("")).toEqual([]);
  });

  it("matches a case-insensitive substring of the name or operator", () => {
    expect(sanctionsHit("My EVIL CORP agent", "ops", ["evil corp"])).toBe(true);
    expect(sanctionsHit("agent", "ops", ["evil corp"])).toBe(false);
    expect(sanctionsHit("agent", "ops", [])).toBe(false);
  });
});

describe("reason texts", () => {
  it("every code has fixed, non-empty human text", () => {
    for (const code of REASON_PRIORITY) {
      expect(REASON_TEXT[code].length).toBeGreaterThan(0);
    }
  });

  it("shows at most 4 principal reasons, in priority order, deduplicated", () => {
    const shown = principalReasons([
      "insufficient_liquidity",
      "score_too_low",
      "mandate_fee",
      "sanctions_hit",
      "mandate_fee",
      "declaration_missing",
    ]);
    expect(shown).toHaveLength(MAX_SHOWN_REASONS);
    expect(shown.map((reason) => reason.code)).toEqual([
      "mandate_fee",
      "sanctions_hit",
      "score_too_low",
      "declaration_missing",
    ]);
    expect(shown[0]?.text).toBe(REASON_TEXT.mandate_fee);
  });
});
