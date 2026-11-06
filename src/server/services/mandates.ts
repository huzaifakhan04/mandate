import { createHash } from "crypto";

import { and, desc, eq, inArray } from "drizzle-orm";

import { ownedAgent } from "../auth/ownership";
import { sessionSecret } from "../auth/session";
import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { agents, events, loans, mandates, noteSeries } from "../db/schema";
import { scoped } from "../db/scoped";
import { TIER_MAX_PER_LOAN_CENTS, isCurrentMandate, type KyaTier } from "../domain/kya";
import { OPEN_LOAN_DB_STATUSES } from "../domain/loanMachine";
import {
  agreementTextHash,
  checkMandate,
  effectivePerLoanCap,
  mandateTermsHash,
  parseMandateSignInput,
  totalOwedHeadroom,
  type MandateInputError,
  type MandateLimits,
  type MandateOffer,
  type MandateReason,
  type MandateSignInput,
  type MandateTerms,
} from "../domain/mandate";

/**
 * Standing mandates (P2 Task 4, Ruling P2-C): one versioned mandate per
 * agent, signed by the principal who claimed it. Signing version n+1
 * supersedes version n in the same transaction; revoking leaves the
 * agent with no current mandate (it can't borrow; existing loans are
 * unaffected). The limits are checked by `domain/mandate.ts`; the
 * principal's exposure (`principalExposure`) is summed over ALL of their
 * agents in the world.
 */

export type MandateRow = typeof mandates.$inferSelect;

export function mandateLimits(row: MandateRow): MandateLimits {
  return {
    maxPerLoanCents: row.maxPerLoanCents,
    maxTotalOwedCents: row.maxTotalOwedCents,
    maxFeeBps: row.maxFeeBps,
    maxTermDays: row.maxTermDays,
    eligibleCollateral: row.eligibleCollateral,
  };
}

/**
 * The agent's current mandate row: the `signed` version belonging to
 * `principalId` (unrevoked). `null` when there is none. Expiry is NOT
 * applied here — `isCurrentMandate` / `computeTier` apply it at `now`.
 */
export async function currentMandateRow(
  db: Db,
  worldId: string,
  agentId: string,
  principalId: string | null,
): Promise<MandateRow | null> {
  if (!principalId) {
    return null;
  }
  const row = await scoped(db, worldId).findLatest(
    mandates,
    and(eq(mandates.agentId, agentId), eq(mandates.principalId, principalId), eq(mandates.status, "signed"))!,
    mandates.version,
  );
  return row && row.signedAt && !row.revokedAt ? row : null;
}

/**
 * What the principal owes on the open loans of ALL their agents in the
 * world. A loan that is accepted or disbursing has `outstanding = 0`
 * until its funds are sent, so it counts at principal + fee; an active
 * loan counts at its outstanding balance.
 */
export async function principalExposure(db: Db, worldId: string, principalId: string): Promise<bigint> {
  const owned = await scoped(db, worldId).selectFields(agents, { id: agents.id }, eq(agents.principalId, principalId));
  if (owned.length === 0) {
    return 0n;
  }
  const open = await scoped(db, worldId).select(
    loans,
    and(
      inArray(
        loans.agentId,
        owned.map((row) => row.id),
      ),
      inArray(loans.status, [...OPEN_LOAN_DB_STATUSES]),
    )!,
  );
  return open.reduce(
    (sum, loan) => sum + (loan.status === "active" ? loan.outstandingCents : loan.principalCents + loan.feeCents),
    0n,
  );
}

/** Reason code: the principal is above the agent's KYA tier per-loan cap. */
export type TierReason = "tier_per_loan";

export interface MandateCheck {
  mandate: MandateRow | null;
  exposureCents: bigint;
  /** `mandate_*` codes, then `tier_per_loan` — empty ⇔ the offer fits. */
  reasons: Array<MandateReason | TierReason>;
}

/**
 * The full limit check for `agentId`'s offer: the current mandate (at
 * `now`), the principal's exposure and the tier's per-loan cap. Callers
 * that need it consistent with concurrent acceptances hold the note
 * series lock (Ruling N) — every acceptance takes it first.
 */
export async function checkAgentMandate(
  db: Db,
  worldId: string,
  agent: { id: string; principalId: string | null },
  tier: KyaTier,
  offer: Omit<MandateOffer, "collateral"> & { collateral: MandateOffer["collateral"] | null },
  now: Date = new Date(),
): Promise<MandateCheck> {
  const row = await currentMandateRow(db, worldId, agent.id, agent.principalId);
  const mandate = row && isCurrentMandate(row, agent.principalId, now) ? row : null;
  const exposureCents = mandate ? await principalExposure(db, worldId, mandate.principalId) : 0n;
  // Without a collateral kind (check_eligibility) the collateral rule is skipped.
  const reasons: Array<MandateReason | TierReason> = checkMandate(
    mandate ? mandateLimits(mandate) : null,
    exposureCents,
    { ...offer, collateral: offer.collateral ?? "none" },
  ).filter((reason) => offer.collateral !== null || reason !== "mandate_collateral");
  if (mandate && offer.principalCents > BigInt(TIER_MAX_PER_LOAN_CENTS[tier])) {
    reasons.push("tier_per_loan");
  }
  return { mandate, exposureCents, reasons };
}

/** The mandate as `check_eligibility` shows it to the agent. */
export interface MandateSummary {
  mandate_id: string;
  version: number;
  max_per_loan_cents: number;
  max_total_owed_cents: number;
  max_fee_bps: number;
  max_term_days: number;
  eligible_collateral: string[];
  expires_at: string | null;
  /** What the principal owes now across all their agents' open loans. */
  principal_total_owed_cents: number;
  /** How much more (principal + fee) may be borrowed before `max_total_owed`. */
  total_owed_headroom_cents: number;
  /** min(tier cap, max_per_loan). */
  per_loan_cap_cents: number;
}

export function mandateSummary(mandate: MandateRow, exposureCents: bigint, tier: KyaTier): MandateSummary {
  const limits = mandateLimits(mandate);
  return {
    mandate_id: mandate.id,
    version: mandate.version,
    max_per_loan_cents: Number(mandate.maxPerLoanCents),
    max_total_owed_cents: Number(mandate.maxTotalOwedCents),
    max_fee_bps: mandate.maxFeeBps,
    max_term_days: mandate.maxTermDays,
    eligible_collateral: [...mandate.eligibleCollateral],
    expires_at: mandate.expiresAt ? mandate.expiresAt.toISOString() : null,
    principal_total_owed_cents: Number(exposureCents),
    total_owed_headroom_cents: Number(totalOwedHeadroom(limits, exposureCents)),
    per_loan_cap_cents: Number(effectivePerLoanCap(TIER_MAX_PER_LOAN_CENTS[tier], limits)),
  };
}

// ---------------------------------------------------------------------
// Signing and revoking (owner actions)
// ---------------------------------------------------------------------

/** sha256 hex of the client IP keyed with SESSION_SECRET (never the IP itself). */
export function hashIp(ip: string | null): string {
  return createHash("sha256")
    .update(`${ip ?? "unknown"}\n${sessionSecret()}`)
    .digest("hex");
}

/** The client IP from the proxy headers (Vercel sets `x-forwarded-for`), or `null`. */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip")?.trim() || null;
}

async function appendMandateEvent(
  tx: Db,
  worldId: string,
  type: "mandate.signed" | "mandate.revoked",
  mandate: MandateRow,
): Promise<void> {
  await scoped(tx, worldId).insert(events, {
    type,
    aggregateType: "mandate",
    aggregateId: mandate.id,
    payload: { agent_id: mandate.agentId, version: mandate.version },
    occurredSimAt: await getSimNow(tx, worldId),
  });
}

export type SignMandateOutcome =
  | { outcome: "signed"; mandate: MandateRow; superseded: MandateRow | null }
  | { outcome: "not_found" }
  | { outcome: "invalid"; errors: MandateInputError[] };

/**
 * Signs a new mandate version for `agentId` as `principalId` (who must
 * have claimed it — else `not_found`). Locks the agent row, so concurrent
 * signings serialise; the previous signed version becomes `superseded`
 * in the same transaction.
 */
export async function signMandate(
  db: Db,
  params: { principalId: string; agentId: string; input: MandateSignInput; ip: string | null; now?: Date },
): Promise<SignMandateOutcome> {
  const now = params.now ?? new Date();
  const agent = await ownedAgent(db, params.principalId, params.agentId);
  if (!agent) {
    return { outcome: "not_found" };
  }
  const parsed = parseMandateSignInput(params.input, now);
  if (!parsed.ok) {
    return { outcome: "invalid", errors: parsed.errors };
  }
  return signTerms(db, agent.worldId, params.principalId, agent.id, parsed.terms, parsed.signerName, hashIp(params.ip), now);
}

/** The transactional half of `signMandate` (also used by the test-only claim shortcut). */
export async function signTerms(
  db: Db,
  worldId: string,
  principalId: string,
  agentId: string,
  terms: MandateTerms,
  signerName: string,
  ipHash: string,
  now: Date = new Date(),
): Promise<SignMandateOutcome> {
  return db.transaction(async (tx) => {
    const [locked] = await scoped(tx, worldId).forUpdate(
      agents,
      and(eq(agents.id, agentId), eq(agents.principalId, principalId))!,
    );
    if (!locked || !locked.claimedAt) {
      return { outcome: "not_found" } as const;
    }

    const [latest] = await scoped(tx, worldId).selectFields(
      mandates,
      { version: mandates.version },
      eq(mandates.agentId, agentId),
      desc(mandates.version),
    );
    const version = (latest?.version ?? 0) + 1;

    const previous = await scoped(tx, worldId).update(
      mandates,
      { status: "superseded", supersededAt: now },
      and(eq(mandates.agentId, agentId), eq(mandates.status, "signed"))!,
    );

    const guaranteeTextHash = agreementTextHash();
    const termsHash = mandateTermsHash({
      worldId,
      agentId,
      principalId,
      version,
      terms,
      signerName,
      signedAt: now,
      guaranteeTextHash,
    });
    const [mandate] = await scoped(tx, worldId).insert(mandates, {
      principalId,
      agentId,
      version,
      maxPerLoanCents: terms.maxPerLoanCents,
      maxTotalOwedCents: terms.maxTotalOwedCents,
      maxFeeBps: terms.maxFeeBps,
      maxTermDays: terms.maxTermDays,
      eligibleCollateral: [...terms.eligibleCollateral],
      expiresAt: terms.expiresAt,
      status: "signed",
      signerName,
      ipHash,
      termsHash,
      guaranteeTextHash,
      signedAt: now,
      signature: { method: "typed_name_and_checkbox", agreed: true, terms_hash: termsHash },
    });
    if (!mandate) {
      throw new Error("Expected a mandates row to be inserted");
    }
    await appendMandateEvent(tx, worldId, "mandate.signed", mandate);
    return { outcome: "signed", mandate, superseded: previous[0] ?? null } as const;
  });
}

export type RevokeMandateOutcome =
  | { outcome: "revoked"; mandate: MandateRow }
  | { outcome: "no_mandate" }
  | { outcome: "not_found" };

/** The world's single note series (`services/worlds.ts`) — the Ruling N lock. */
const MANDATE_POOL_A_NAME = "Mandate Pool A";

/**
 * Revokes the agent's current mandate (owner only). Existing loans are
 * unaffected.
 *
 * Lock order (P2 final review, M3): the note series row first, then the
 * agent row — Ruling N, the same order every `accept_offer` takes. So a
 * revoke and a concurrent acceptance serialise: the acceptance either
 * commits first (the loan stands, as any existing loan does) or runs after
 * the revoke and is refused `MANDATE_REVOKED`; never a loan accepted
 * against a mandate revoked mid-check.
 */
export async function revokeMandate(
  db: Db,
  params: { principalId: string; agentId: string; now?: Date },
): Promise<RevokeMandateOutcome> {
  const now = params.now ?? new Date();
  const agent = await ownedAgent(db, params.principalId, params.agentId);
  if (!agent) {
    return { outcome: "not_found" };
  }
  return db.transaction(async (tx) => {
    await scoped(tx, agent.worldId).forUpdate(noteSeries, eq(noteSeries.name, MANDATE_POOL_A_NAME));
    const [locked] = await scoped(tx, agent.worldId).forUpdate(
      agents,
      and(eq(agents.id, agent.id), eq(agents.principalId, params.principalId))!,
    );
    if (!locked) {
      return { outcome: "not_found" } as const;
    }
    const [revoked] = await scoped(tx, agent.worldId).update(
      mandates,
      { status: "revoked", revokedAt: now },
      and(eq(mandates.agentId, agent.id), eq(mandates.status, "signed"))!,
    );
    if (!revoked) {
      return { outcome: "no_mandate" } as const;
    }
    await appendMandateEvent(tx, agent.worldId, "mandate.revoked", revoked);
    return { outcome: "revoked", mandate: revoked } as const;
  });
}

/** Every version of the agent's mandates, newest first (owner view; Task 5's dashboard). */
export async function mandateHistory(db: Db, principalId: string, agentId: string): Promise<MandateRow[] | null> {
  const agent = await ownedAgent(db, principalId, agentId);
  if (!agent) {
    return null;
  }
  const rows = await scoped(db, agent.worldId).select(mandates, eq(mandates.agentId, agent.id));
  return rows.sort((a, b) => b.version - a.version);
}
