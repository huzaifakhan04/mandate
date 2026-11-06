import { fail, type Envelope, type NextAction } from "./envelope";
import type { BorrowBlocker } from "../domain/kya";

/**
 * What an agent should tell its human when KYA blocks borrowing (P2 Task
 * 2). Both are `human_approval` signals: the human must act in a browser
 * (claim the agent; sign a mandate), then the agent checks `get_status`.
 */

function dashboardUrl(): string {
  const base = (process.env.PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/dashboard`;
}

export function claimNextAction(claimUrl: string): NextAction {
  return { tool: "human_approval", args: { url: claimUrl, who: "owner", then: { tool: "get_status", args: {} } } };
}

export function mandateNextAction(): NextAction {
  return { tool: "human_approval", args: { url: dashboardUrl(), who: "owner", then: { tool: "get_status", args: {} } } };
}

/** The human-facing step for the first blocker, as one sentence. */
export function blockerInstruction(blockers: readonly BorrowBlocker[], claimUrl: string | null): string {
  if (blockers.includes("claim_required")) {
    return claimUrl
      ? `Ask your human to open ${claimUrl} to claim you (they verify with PayPal, then click Claim).`
      : "Ask your human to claim you (call get_status for your claim link).";
  }
  if (blockers.includes("mandate_missing")) {
    return `Ask your human to sign a borrowing mandate for you at ${dashboardUrl()}.`;
  }
  return "";
}

export function blockerNextActions(blockers: readonly BorrowBlocker[], claimUrl: string | null): NextAction[] {
  if (blockers.includes("claim_required")) {
    return claimUrl ? [claimNextAction(claimUrl)] : [{ tool: "get_status", args: {} }];
  }
  if (blockers.includes("mandate_missing")) {
    return [mandateNextAction()];
  }
  return [];
}

/**
 * `apply_for_loan` / `accept_offer` when the tier forbids borrowing:
 * 403 `CLAIM_REQUIRED` (unclaimed; `data.claim_url` — the caller is the
 * agent itself) or 403 `MANDATE_REQUIRED` (claimed, no current mandate).
 */
export function borrowBlockedEnvelope(
  blockers: readonly BorrowBlocker[],
  claimUrl: string | null,
): Envelope<Record<string, unknown>> {
  const instruction = blockerInstruction(blockers, claimUrl);
  const envelope = blockers.includes("claim_required")
    ? fail(
        "CLAIM_REQUIRED",
        `Borrowing needs a human owner: this agent is unclaimed (tier 0 may only lend). ${instruction}`,
        ["claim_required"],
        { claim_url: claimUrl },
      )
    : fail(
        "MANDATE_REQUIRED",
        `Borrowing needs a signed mandate from your owner (they set your limits). ${instruction}`,
        ["mandate_missing"],
      );
  envelope.next_actions = blockerNextActions(blockers, claimUrl);
  return envelope;
}
