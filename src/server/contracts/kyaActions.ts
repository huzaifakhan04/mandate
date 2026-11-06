import { fail, type Envelope, type NextAction } from "./envelope";
import type { BorrowBlocker } from "../domain/kya";
import type { MandateSummary } from "../services/mandates";

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

/**
 * `accept_offer` when the mandate the offer was made under is no longer
 * current (P2 Task 4): 409 `MANDATE_REVOKED` with `mandate_revoked`
 * (revoked or expired — the human must sign again) or
 * `mandate_superseded` (a newer version was signed — apply again under it).
 */
export function mandateRevokedEnvelope(
  reason: "mandate_revoked" | "mandate_superseded",
  retry: { amount_cents: number; term_days: number },
): Envelope<Record<string, unknown>> {
  if (reason === "mandate_superseded") {
    const envelope = fail(
      "MANDATE_REVOKED",
      "Your owner signed a new version of your mandate after this offer was made, so it can't be accepted. " +
        "Check eligibility and apply again under the new limits.",
      ["mandate_superseded"],
    );
    envelope.next_actions = [{ tool: "check_eligibility", args: { ...retry } }];
    return envelope;
  }
  const envelope = fail(
    "MANDATE_REVOKED",
    `Your owner's mandate is no longer in force (revoked or expired), so this offer can't be accepted. ` +
      `Ask your human to sign a new mandate at ${dashboardUrl()}.`,
    ["mandate_revoked"],
  );
  envelope.next_actions = [mandateNextAction()];
  return envelope;
}

/**
 * `accept_offer` when the offer no longer fits the mandate or the tier's
 * per-loan cap (P2 Task 4) — typically because the owner's total owed
 * across all their agents rose since the offer: 400 `MANDATE_LIMIT`.
 */
export function mandateLimitEnvelope(
  reasons: readonly string[],
  mandate: MandateSummary,
  retry: { amount_cents: number; term_days: number },
): Envelope<Record<string, unknown>> {
  const envelope = fail(
    "MANDATE_LIMIT",
    `This offer no longer fits your owner's mandate: ${reasons.join(", ")}. ` +
      `Your owner can still take on ${mandate.total_owed_headroom_cents} cents (principal + fee) across all their agents; ` +
      "check eligibility for a smaller amount, or ask your human to raise the limits.",
    [...reasons],
    { ...mandate },
  );
  envelope.next_actions = [{ tool: "check_eligibility", args: { ...retry } }];
  return envelope;
}
