/**
 * Know-Your-Agent tiers (P2 Global Constraints, "KYA tiers"). The tier is
 * always computed from the facts below — never stored as a source of
 * truth (`agents.kya_tier` is a legacy P0 column nothing reads).
 *
 * | Tier | Requirement                                                   | Borrow                     |
 * |------|---------------------------------------------------------------|----------------------------|
 * | T0   | unclaimed (or claimed with no current signed mandate)         | no                         |
 * | T1   | claimed by a verified principal + a current signed mandate    | per loan ≤ 25000 cents     |
 * | T2   | T1 + ≥ 1 approved KYA document + a registered Ed25519 key     | per loan ≤ 50000 cents     |
 *
 * Every tier may lend (buy/redeem notes).
 */

export type KyaTier = 0 | 1 | 2;

/** Why an agent may not borrow right now. */
export type BorrowBlocker = "claim_required" | "mandate_missing";

/** What a T1 agent still needs for T2. */
export type TierRequirement = "kya_document_missing" | "signing_key_missing";

export interface KyaAgentFacts {
  principalId: string | null;
  claimedAt: Date | null;
}

export interface KyaPrincipalFacts {
  id: string;
  verifiedAt: Date | null;
}

export interface KyaMandateFacts {
  principalId: string;
  signedAt: Date | null;
  revokedAt: Date | null;
  /** Optional until Task 4 adds the column. */
  expiresAt?: Date | null;
}

export interface KyaDocumentFacts {
  reviewStatus: string;
}

export interface KyaKeyFacts {
  revokedAt?: Date | null;
}

export interface TierResult {
  tier: KyaTier;
  /** Claimed by a verified principal. */
  claimed: boolean;
  /** The principal's mandate for this agent is signed, unrevoked and unexpired. */
  hasCurrentMandate: boolean;
  /** Empty exactly when the agent may borrow. */
  borrowBlockers: BorrowBlocker[];
  /** What T1 still lacks for T2 (empty at T0 and T2). */
  nextTierRequirements: TierRequirement[];
  /** The tier's per-loan ceiling in cents (0 at T0). */
  maxPerLoanCents: number;
}

export const TIER_MAX_PER_LOAN_CENTS: Record<KyaTier, number> = { 0: 0, 1: 25000, 2: 50000 };

/** Whether `mandate` is the claiming principal's signed, unrevoked, unexpired mandate at `now`. */
export function isCurrentMandate(mandate: KyaMandateFacts | null, principalId: string | null, now: Date): boolean {
  if (!mandate || !principalId || mandate.principalId !== principalId) {
    return false;
  }
  if (!mandate.signedAt || mandate.revokedAt) {
    return false;
  }
  return !mandate.expiresAt || mandate.expiresAt.getTime() > now.getTime();
}

/**
 * Pure: the agent's KYA tier from its claim, its principal, the current
 * mandate (or `null`), its KYA documents and its signing key (or `null`).
 */
export function computeTier(
  agent: KyaAgentFacts,
  principal: KyaPrincipalFacts | null,
  mandate: KyaMandateFacts | null,
  docs: readonly KyaDocumentFacts[],
  key: KyaKeyFacts | null,
  now: Date = new Date(),
): TierResult {
  const claimed =
    agent.principalId !== null &&
    agent.claimedAt !== null &&
    principal !== null &&
    principal.id === agent.principalId &&
    principal.verifiedAt !== null;
  const hasCurrentMandate = claimed && isCurrentMandate(mandate, agent.principalId, now);

  if (!claimed) {
    return result(0, false, false, ["claim_required"], []);
  }
  if (!hasCurrentMandate) {
    return result(0, true, false, ["mandate_missing"], []);
  }

  const missing: TierRequirement[] = [];
  if (!docs.some((doc) => doc.reviewStatus === "approved")) {
    missing.push("kya_document_missing");
  }
  if (!key || key.revokedAt) {
    missing.push("signing_key_missing");
  }
  return result(missing.length === 0 ? 2 : 1, true, true, [], missing);
}

function result(
  tier: KyaTier,
  claimed: boolean,
  hasCurrentMandate: boolean,
  borrowBlockers: BorrowBlocker[],
  nextTierRequirements: TierRequirement[],
): TierResult {
  return {
    tier,
    claimed,
    hasCurrentMandate,
    borrowBlockers,
    nextTierRequirements,
    maxPerLoanCents: TIER_MAX_PER_LOAN_CENTS[tier],
  };
}
