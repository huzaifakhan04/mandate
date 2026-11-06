import { REASON_PRIORITY } from "@/server/domain/reasons";

import type { LoanOfficerInput, LoanOfficerOutput } from "./schemas";

/**
 * Policy checks on a schema-valid loan officer output (Review Focus 1):
 * the LLM explains the decision but must never add reasons or claim an
 * approval on a decline. Any violation sends `runRole` to the template.
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
  return null;
}
