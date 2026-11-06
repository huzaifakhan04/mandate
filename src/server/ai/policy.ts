import { REASON_PRIORITY } from "@/server/domain/reasons";

import type { LoanOfficerInput, LoanOfficerOutput } from "./schemas";

/**
 * Policy checks on a schema-valid loan officer output (Review Focus 1):
 * the LLM explains the decision but must never add reasons or claim an
 * approval on a decline, claim the money already moved, or say an offer
 * with a fee is free. Any violation sends `runRole` to the template.
 * The checks are deliberately conservative — a false positive only costs
 * the nicer wording.
 */

/**
 * Approval claims: a passive "is/was/been/be approved|granted|funded",
 * "we approved/granted/funded…", or "congratulations" — unless the clause
 * before it negates it ("was not approved", "cannot be funded"). Plain
 * adjective uses ("an approved document", "automatic-approval limit") are
 * not claims.
 */
const APPROVAL_CLAIM_RE =
  /\b(?:(?:is|was|were|been|be|are|'re|am)\s+(?:now\s+)?(?:approved|granted|funded)|we(?:\s+have|'ve)?\s+(?:approved|granted|funded)|congratulations)\b/gi;
const NEGATION_RE = /\b(?:not|never|no|cannot|unable|declined)\b|n't\b/i;

export function claimsApproval(text: string): boolean {
  for (const match of text.matchAll(APPROVAL_CLAIM_RE)) {
    if (/^congratulations$/i.test(match[0])) {
      return true;
    }
    const before = text.slice(Math.max(0, match.index! - 40), match.index! + match[0].length);
    const clause = before.split(/[.;:!?\n]/).pop() ?? "";
    if (!NEGATION_RE.test(clause)) {
      return true;
    }
  }
  return false;
}

/**
 * An apply never moves money: an offer still has to be accepted before
 * anything disburses. So "has been funded / disbursed / paid out" (not
 * negated) is a misstatement on any decision.
 */
const FUNDED_CLAIM_RE =
  /\b(?:(?:is|was|were|been|be|are|'re|am)\s+(?:now\s+|already\s+)?(?:funded|disbursed|paid\s+out|deposited)|we(?:\s+have|'ve)?\s+(?:funded|disbursed|paid\s+out|deposited))\b/gi;

export function claimsFunded(text: string): boolean {
  for (const match of text.matchAll(FUNDED_CLAIM_RE)) {
    // The whole clause around the match: a negation or a condition ("once you accept") makes it no claim.
    const start = match.index!;
    const before = (text.slice(Math.max(0, start - 40), start).split(/[.;:!?\n]/).pop() ?? "");
    const after = text.slice(start + match[0].length, start + match[0].length + 40).split(/[.;:!?\n]/)[0] ?? "";
    const negatedBefore = /\b(?:not|never|no|cannot|unable|until|once|after|when|if|upon)\b|n't\b/i.test(before);
    const conditionalAfter = /^\s*(?:\S+\s+){0,2}(?:until|once|after|when|if|upon)\b/i.test(after);
    if (!negatedBefore && !conditionalAfter) {
      return true;
    }
  }
  return false;
}

/** "no fee", "fee-free", "free of charge", "zero fee", "$0 fee" — a misstated price when the fee is > 0. */
const NO_FEE_RE = /\b(?:no|zero)\s+(?:fees?|charge|cost|interest)\b|\bfee[-\s]free\b|\bfree\s+of\s+charge\b|\$0(?:\.00)?\s+fee\b|\binterest[-\s]free\b/i;

function allText(output: LoanOfficerOutput): string {
  return [output.summary, ...output.reasons_explained.map((r) => r.explanation), ...output.next_steps].join("\n");
}

/** `null` when the output is within policy, else a short description of the first violation. */
export function loanOfficerPolicyViolation(input: LoanOfficerInput, output: LoanOfficerOutput): string | null {
  const allowed = new Set<string>(input.reasons.map((r) => r.code));
  for (const item of output.reasons_explained) {
    if (!allowed.has(item.code)) {
      return `reason_not_in_input:${item.code}`;
    }
  }
  const text = allText(output);
  for (const code of REASON_PRIORITY) {
    if (!allowed.has(code) && new RegExp(`\\b${code}\\b`, "i").test(text)) {
      return `reason_not_in_input:${code}`;
    }
  }
  if (input.decision === "decline" && claimsApproval(text)) {
    return "approval_claim_on_decline";
  }
  if (claimsFunded(text)) {
    return "funded_claim";
  }
  if (input.feeCents !== null && input.feeCents > 0 && NO_FEE_RE.test(text)) {
    return "fee_misstated";
  }
  return null;
}
