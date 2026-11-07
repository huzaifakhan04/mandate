import { mandateFeeAdvice, REASON_TEXT, type ReasonCode } from "@/server/domain/reasons";

import type {
  AiRole,
  KyaDeskInput,
  KyaDeskOutput,
  LoanOfficerInput,
  LoanOfficerOutput,
  RiskOfficerInput,
  RiskOfficerOutput,
  RoleIO,
  TreasuryOfficerInput,
  TreasuryOfficerOutput,
} from "./schemas";

/**
 * Deterministic template fallbacks for each AI role: built only from the
 * same (allowlisted) input the LLM would see, with reason text from
 * `domain/reasons.ts`. Used when OpenAI is disabled, slow, erroring, or
 * returns anything invalid or off-policy.
 */

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function percent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

const NEXT_STEP: Partial<Record<ReasonCode, string>> = {
  amount_out_of_range: "Apply for an amount between $10 and $500.",
  term_out_of_range: "Apply for a term between 7 and 30 days.",
  claim_required: "Ask your human to claim you and verify their identity.",
  tier_per_loan: "Apply for a smaller amount, or raise your KYA tier (signing key and an approved document).",
  risk_review: "Call get_status to see the open risk flag; your human can request a review from the dashboard.",
  mandate_missing: "Ask your human to sign a current mandate that authorizes borrowing.",
  mandate_per_loan: "Apply for an amount within your mandate's per-loan limit, or ask your human to raise it.",
  mandate_total_owed: "Repay existing loans or ask your human to raise the mandate's total-owed limit.",
  mandate_fee: "Ask your human to raise the mandate's maximum fee, or apply for a shorter term or with invoice collateral.",
  mandate_term: "Apply for a term within your mandate's maximum term.",
  mandate_collateral: "Offer collateral your mandate allows.",
  delinquent_principal: "Repay the substandard loan first; the freeze lifts as soon as it is repaid.",
  sanctions_hit: "Contact the bank; the application cannot proceed until screening is resolved.",
  insufficient_credit_history: "Build history with a small invoice-backed loan (invoice ≥ 1.5× the amount) and repay it on time.",
  score_too_low: "Improve your score: verify identity (signing key, approved document) and repay loans on time.",
  amount_exceeds_limit: "Apply for an amount within the credit limit for your grade.",
  manual_review_declined: "Apply for $50 or less, or improve your grade first.",
  insufficient_collateral: "Attach an invoice worth at least 1.1× the amount requested.",
  declaration_missing:
    "Re-apply with declarations.no_other_debt: true and attest: true, but only if both are true (no other outstanding debts; the application is accurate).",
  open_loan_exists: "Repay your open loan before applying again.",
  insufficient_liquidity: "Try again later, or apply for a smaller amount.",
  pool_utilization_high: "Try again after repayments or new note purchases bring the pool below 90% lent out.",
  reserve_floor: "Apply for a smaller amount, or try again after repayments or new note purchases add cash.",
  concentration_limit: "Apply for a smaller amount, or repay your human's open loans first.",
  daily_budget_exhausted: "Apply for a smaller amount, or try again on the next simulated day when the budget resets.",
};

export function loanOfficerTemplate(input: LoanOfficerInput): LoanOfficerOutput {
  const ask = `${dollars(input.amountCents)} over ${input.termDays} days`;
  if (input.decision === "approve") {
    const fee = input.feeCents === null ? "" : ` The fee is ${dollars(input.feeCents)}`;
    const apr = input.aprBps === null ? "" : ` (APR ${percent(input.aprBps)})`;
    return {
      summary: `Your application for ${ask} meets our lending criteria (score ${input.score}, grade ${input.grade}).${fee}${apr}${fee ? "." : ""}`,
      reasons_explained: [],
      next_steps: [
        "Review the offer disclosure and accept it before it expires.",
        "Repay on or before the due date to build your credit history.",
      ],
    };
  }
  const stepFor = (code: ReasonCode): string | undefined =>
    code === "mandate_fee" && input.mandateMaxFeeBps != null && input.feeCents !== null
      ? mandateFeeAdvice(input.mandateMaxFeeBps, input.feeCents, input.amountCents)
      : NEXT_STEP[code];
  const steps = [...new Set(input.reasons.map((r) => stepFor(r.code)).filter((s): s is string => Boolean(s)))];
  return {
    summary: `Your application for ${ask} was declined (score ${input.score}, grade ${input.grade}). The principal reasons are listed below.`,
    reasons_explained: input.reasons.map((r) => ({ code: r.code, explanation: REASON_TEXT[r.code] })),
    next_steps: steps.slice(0, 4),
  };
}

export function riskOfficerTemplate(input: RiskOfficerInput): RiskOfficerOutput {
  const c = input.components;
  const coverage =
    input.invoiceCoverageBps === null ? "no invoice collateral" : `invoice coverage ${(input.invoiceCoverageBps / 10000).toFixed(2)}×`;
  const outcome =
    input.decision === "approve"
      ? "Approved by the rules pipeline."
      : `Declined by the rules pipeline (${input.reasons.map((r) => r.code).join(", ") || "no reason recorded"}).`;
  const concerns: string[] = [];
  if (c.history === 0) concerns.push("No on-time repayment history yet.");
  if (c.identity < 25) concerns.push(`Identity verification incomplete (${c.identity}/25).`);
  if (input.invoiceCoverageBps === null) concerns.push("Unsecured: no invoice collateral.");
  if (c.exposure < 10) concerns.push(`Existing exposure reduces headroom (${c.exposure}/10).`);
  if (input.approval === "manual_review_declined") concerns.push("Amount is above the grade D automatic-approval limit.");
  return {
    memo:
      `Grade ${input.grade}, score ${input.score} (identity ${c.identity}/25, history ${c.history}/35, tenure ${c.tenure}/10, ` +
      `collateral ${c.collateral}/20, exposure ${c.exposure}/10). Request ${dollars(input.amountCents)} for ${input.termDays} days, ` +
      `${coverage}. ${outcome} Template memo: the AI risk officer was not used.`,
    concerns: concerns.slice(0, 5),
  };
}

export function kyaDeskTemplate(input: KyaDeskInput): KyaDeskOutput {
  const status = input.document.autoReviewStatus;
  const verdict: KyaDeskOutput["verdict"] = status === "approved" ? "approve" : status === "rejected" ? "reject" : "needs_info";
  return {
    verdict,
    findings: [
      `Automatic review status: ${status}.`,
      `Document kind ${input.document.kind}, ${input.document.contentType ?? "unknown type"}, ${input.document.sizeBytes ?? "unknown"} bytes.`,
    ],
  };
}

/** P5 Task 3: the daily treasury memo from the economy numbers alone. */
export function treasuryOfficerTemplate(input: TreasuryOfficerInput): TreasuryOfficerOutput {
  const realBps = input.baseRateBps - input.inflationRateBps;
  const observations = [
    `Base rate ${percent(input.baseRateBps)} a year against inflation of ${percent(input.inflationRateBps)} (real ${percent(realBps)}); inflation index ${(input.inflationIndexBp / 10000).toFixed(4)}.`,
    `Utilization ${percent(input.utilizationBps)} (${dollars(input.loansReceivableCents)} lent across ${input.openLoans} open loan(s)); utilization premium +${input.utilizationPremiumBps} bps.`,
    `Cash ${dollars(input.cashCents)} (${dollars(input.availableLiquidityCents)} available) against ${dollars(input.notesPayableCents)} of notes: reserve ratio ${percent(input.reserveRatioBps)}, floor ${dollars(input.reserveFloorCents)} (${percent(input.reserveFloorBps)}).`,
    input.dailyBudgetCents === null
      ? `No lending budget set yet today; ${dollars(input.budgetUsedCents)} lent.`
      : `Lending budget ${dollars(input.budgetUsedCents)} of ${dollars(input.dailyBudgetCents)} used today.`,
    `Loss allowance ${dollars(input.allowanceCents)} (gross of note-holder loss sharing).`,
  ];
  const risks: string[] = [];
  if (input.queuedRedemptions > 0) {
    risks.push(`${input.queuedRedemptions} redemption(s) (${dollars(input.queuedRedemptionCents)}) are queued behind the reserve floor.`);
  }
  if (input.availableLiquidityCents - input.queuedRedemptionCents < input.reserveFloorCents) {
    risks.push("Available cash is below the reserve floor: new loans are declined until cash recovers.");
  }
  if (input.utilizationBps > 9000) {
    risks.push("Utilization is above 90%: the bank is not making new loans.");
  } else if (input.utilizationBps > 7500) {
    risks.push("Utilization is above 75%: the utilization premium is raising the price of new loans.");
  }
  if (input.dailyBudgetCents !== null && input.budgetUsedCents >= input.dailyBudgetCents && input.dailyBudgetCents > 0) {
    risks.push("Today's lending budget is used up.");
  }
  if (input.loansReceivableCents > 0 && input.allowanceCents * 10 > input.loansReceivableCents) {
    risks.push("The loss allowance is above 10% of loans outstanding: expected credit losses are high.");
  }
  if (realBps < 0) {
    risks.push("The real base rate is negative: note holders' real returns are under pressure.");
  }
  return {
    headline: `Day ${input.simDay}: utilization ${percent(input.utilizationBps)}, reserve ratio ${percent(input.reserveRatioBps)}, base rate ${percent(input.baseRateBps)}${input.queuedRedemptions > 0 ? `, ${input.queuedRedemptions} redemption(s) queued` : ""}.`,
    observations,
    risks: risks.slice(0, 5),
  };
}

export const TEMPLATES: { [R in AiRole]: (input: RoleIO[R]["input"]) => RoleIO[R]["output"] } = {
  kya_desk: kyaDeskTemplate,
  loan_officer: loanOfficerTemplate,
  risk_officer: riskOfficerTemplate,
  treasury_officer: treasuryOfficerTemplate,
};
