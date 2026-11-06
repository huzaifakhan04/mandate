import { and, eq, isNotNull, isNull } from "drizzle-orm";

import type { Db } from "../db/client";
import { agents, kyaDocuments, mandates, principals } from "../db/schema";
import { scoped } from "../db/scoped";
import { computeTier, type KyaMandateFacts, type TierResult } from "../domain/kya";
import { claimLinkForAgent, type ClaimLink } from "./claims";

type AgentRow = typeof agents.$inferSelect;

/**
 * The claiming principal's current mandate for `agent`: its newest signed,
 * unrevoked version. `null` when there is none (always, until Task 4 lets
 * owners sign one — the test-only claim shortcut inserts one directly).
 */
export async function currentMandate(db: Db, worldId: string, agent: AgentRow): Promise<KyaMandateFacts | null> {
  if (!agent.principalId) {
    return null;
  }
  const row = await scoped(db, worldId).findLatest(
    mandates,
    and(
      eq(mandates.agentId, agent.id),
      eq(mandates.principalId, agent.principalId),
      isNotNull(mandates.signedAt),
      isNull(mandates.revokedAt),
    )!,
    mandates.version,
  );
  return row ? { principalId: row.principalId, signedAt: row.signedAt, revokedAt: row.revokedAt } : null;
}

/** `computeTier` over the agent's stored facts (claim, principal, mandate, documents, key). */
export async function tierForAgent(db: Db, worldId: string, agent: AgentRow, now: Date = new Date()): Promise<TierResult> {
  const [principal] = agent.principalId
    ? await db.select().from(principals).where(eq(principals.id, agent.principalId)).limit(1)
    : [];
  const mandate = await currentMandate(db, worldId, agent);
  const docs = agent.principalId
    ? await scoped(db, worldId).select(
        kyaDocuments,
        and(eq(kyaDocuments.agentId, agent.id), eq(kyaDocuments.principalId, agent.principalId))!,
      )
    : [];
  return computeTier(
    { principalId: agent.principalId, claimedAt: agent.claimedAt },
    principal ? { id: principal.id, verifiedAt: principal.verifiedAt } : null,
    mandate,
    docs,
    agent.ed25519Pubkey ? {} : null,
    now,
  );
}

export interface AgentKya {
  agent: AgentRow;
  tier: TierResult;
}

/** The agent row plus its computed tier. Throws if the agent doesn't exist in `worldId`. */
export async function loadAgentKya(db: Db, worldId: string, agentId: string, now: Date = new Date()): Promise<AgentKya> {
  const agent = await scoped(db, worldId).findOne(agents, eq(agents.id, agentId));
  if (!agent) {
    throw new Error(`Expected agent ${agentId} to exist in world ${worldId}`);
  }
  return { agent, tier: await tierForAgent(db, worldId, agent, now) };
}

export interface BorrowGate {
  tier: TierResult;
  /** The claim link while unclaimed (only ever shown to the agent itself), else `null`. */
  claimLink: ClaimLink | null;
}

/**
 * The tier check every borrowing path runs first (`check_eligibility`,
 * `apply_for_loan`, `accept_offer`): `tier.borrowBlockers` empty ⇔ may
 * borrow. While unclaimed it also returns the claim link (rotating an
 * expired token), so the agent can hand it to its human — unless
 * `withClaimLink: false` (an envelope that gets stored under an
 * idempotency key must never carry the token).
 */
export async function borrowGate(
  db: Db,
  worldId: string,
  agentId: string,
  options: { now?: Date; withClaimLink?: boolean } = {},
): Promise<BorrowGate> {
  const now = options.now ?? new Date();
  const { agent, tier } = await loadAgentKya(db, worldId, agentId, now);
  const claimLink =
    tier.claimed || options.withClaimLink === false ? null : await claimLinkForAgent(db, worldId, agent, now);
  return { tier, claimLink };
}
