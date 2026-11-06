import { describe, expect, it } from "vitest";
import { z } from "zod";

import { claimsApproval, claimsFunded, loanOfficerPolicyViolation } from "@/server/ai/policy";
import { redact, redactText } from "@/server/ai/redact";
import { cleanText } from "@/server/ai/sanitize";
import { AI_ROLES, OUTPUT_JSON_SCHEMAS, OUTPUT_SCHEMAS, type LoanOfficerInput } from "@/server/ai/schemas";
import { kyaDeskTemplate, loanOfficerTemplate, riskOfficerTemplate } from "@/server/ai/templates";
import { principalReasons, REASON_PRIORITY } from "@/server/domain/reasons";

function loanInput(codes: string[], decision: "approve" | "decline" = "decline"): LoanOfficerInput {
  return {
    decision,
    reasons: principalReasons(codes),
    score: 42,
    grade: "D",
    scoreFactors: [],
    amountCents: 5000,
    termDays: 14,
    feeCents: decision === "approve" ? 58 : null,
    aprBps: decision === "approve" ? 3023 : null,
    effectiveCapCents: 10000,
  };
}

describe("schemas", () => {
  it("each strict JSON schema names exactly the zod schema's keys, all required, no extras", () => {
    for (const role of AI_ROLES) {
      const json = OUTPUT_JSON_SCHEMAS[role] as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
      const zodKeys = Object.keys((OUTPUT_SCHEMAS[role] as z.ZodObject).shape).sort();
      expect(Object.keys(json.properties).sort()).toEqual(zodKeys);
      expect([...json.required].sort()).toEqual(zodKeys);
      expect(json.additionalProperties).toBe(false);
    }
  });
});

describe("templates", () => {
  it("every reason code's decline template is schema-valid and within policy", () => {
    for (const code of REASON_PRIORITY) {
      const input = loanInput([code]);
      const output = loanOfficerTemplate(input);
      expect(OUTPUT_SCHEMAS.loan_officer.safeParse(output).success).toBe(true);
      expect(loanOfficerPolicyViolation(input, output)).toBeNull();
      expect(output.reasons_explained.map((r) => r.code)).toEqual([code]);
      expect(output.next_steps.length).toBeGreaterThan(0);
    }
  });

  it("the approve template is valid, within policy and deterministic", () => {
    const input = loanInput([], "approve");
    expect(loanOfficerTemplate(input)).toEqual(loanOfficerTemplate(input));
    expect(OUTPUT_SCHEMAS.loan_officer.safeParse(loanOfficerTemplate(input)).success).toBe(true);
    expect(loanOfficerTemplate(input).summary).toContain("$50.00");
    expect(loanOfficerPolicyViolation(input, loanOfficerTemplate(input))).toBeNull();
  });

  it("risk officer and KYA desk templates are schema-valid", () => {
    const risk = riskOfficerTemplate({
      decision: "approve",
      approval: "auto",
      reasons: [],
      score: 40,
      grade: "D",
      components: { identity: 10, history: 0, tenure: 0, collateral: 20, exposure: 10 },
      scoreFactors: [],
      amountCents: 1000,
      termDays: 7,
      invoiceCoverageBps: 15000,
    });
    expect(OUTPUT_SCHEMAS.risk_officer.safeParse(risk).success).toBe(true);
    const doc = { kind: "id_document", fileName: null, contentType: "image/png", sizeBytes: 10 };
    const agent = { name: "a", operator: "b", tier: 1 };
    expect(kyaDeskTemplate({ agent, document: { ...doc, autoReviewStatus: "approved" } }).verdict).toBe("approve");
    expect(kyaDeskTemplate({ agent, document: { ...doc, autoReviewStatus: "rejected" } }).verdict).toBe("reject");
    expect(kyaDeskTemplate({ agent, document: { ...doc, autoReviewStatus: "pending" } }).verdict).toBe("needs_info");
  });
});

describe("policy", () => {
  it("detects approval claims but not negations or adjectives", () => {
    expect(claimsApproval("Your loan has been approved.")).toBe(true);
    expect(claimsApproval("Congratulations on your application.")).toBe(true);
    expect(claimsApproval("We approved $50.")).toBe(true);
    expect(claimsApproval("You're approved!")).toBe(true);
    expect(claimsApproval("Your application was not approved.")).toBe(false);
    expect(claimsApproval("The loan cannot be funded right now.")).toBe(false);
    expect(claimsApproval("Upload an approved document; the automatic-approval limit is $50.")).toBe(false);
  });

  it("allows an approve decision to mention approval", () => {
    const input = loanInput([], "approve");
    expect(
      loanOfficerPolicyViolation(input, { summary: "Your loan is approved.", reasons_explained: [], next_steps: [] }),
    ).toBeNull();
  });

  it("an offer is not funded and not free: funded claims and 'no fee' on a priced offer are violations", () => {
    const input = loanInput([], "approve");
    const out = (summary: string) => ({ summary, reasons_explained: [], next_steps: [] });
    expect(loanOfficerPolicyViolation(input, out("Your loan was approved and has been funded with no fee."))).toBe("funded_claim");
    expect(loanOfficerPolicyViolation(input, out("Your offer is ready, with no fee at all."))).toBe("fee_misstated");
    expect(loanOfficerPolicyViolation(input, out("Fee-free money!"))).toBe("fee_misstated");
    expect(loanOfficerPolicyViolation(input, out("Funds are disbursed once you accept the offer. The fee is $0.58."))).toBeNull();
    expect(claimsFunded("We have funded your loan.")).toBe(true);
    expect(claimsFunded("Nothing is funded until you accept.")).toBe(false);
    expect(claimsFunded("The loan will be paid out after you accept.")).toBe(false);
  });
});

describe("sanitize", () => {
  it("strips URLs and bare domains/paths, but keeps decimals, multiples, amounts and file names", () => {
    expect(cleanText("See https://evil.example/claim and www.evil.example now")).toBe("See [link removed] and [link removed] now");
    expect(cleanText("Visit evil.com or pay.evil.co.uk/claim?x=1 to continue")).toBe("Visit [link removed] or [link removed] to continue");
    expect(cleanText("Coverage is 1.5x (≥ 1.1×); the fee is $0.58 at 302.43% APR, v2.1.")).toBe(
      "Coverage is 1.5x (≥ 1.1×); the fee is $0.58 at 302.43% APR, v2.1.",
    );
    expect(cleanText("The file registration.pdf (scan.png) looks fine, e.g. it is legible.")).toBe(
      "The file registration.pdf (scan.png) looks fine, e.g. it is legible.",
    );
  });
});

describe("redact", () => {
  it("strips emails, mnd_ keys, UUIDs and payer ids, deep", () => {
    expect(redactText("mail bob.x+1@sub.example.co.uk now")).toBe("mail [email] now");
    expect(redactText("key mnd_abcdefgh_abcdefghijklmnopqrstuvwxyz234567 end")).toBe("key [key] end");
    expect(redactText("id 0b6c8a52-3f0e-4c64-9b1f-1c2d3e4f5a6b.")).toBe("id [id].");
    expect(redactText("payer SIMPAYER00001 and 7WJ8XLGQZ9P2A")).toBe("payer [payer-id] and [payer-id]");
    expect(redactText("PASSPORTSCANS is a word")).toBe("PASSPORTSCANS is a word");
    expect(redact({ a: ["x@y.io", { b: "mnd_ab" }], n: 5, z: null })).toEqual({ a: ["[email]", { b: "[key]" }], n: 5, z: null });
  });
});
