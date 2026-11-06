import { createHash, createHmac, randomBytes } from "crypto";

import { and, eq, isNull } from "drizzle-orm";

import { sessionSecret } from "../auth/session";
import type { Db } from "../db/client";
import { agents, principals } from "../db/schema";
import { scoped } from "../db/scoped";
import { ensureMainWorldOnce } from "./worlds";

/**
 * Path A of the claim flow (P2 Task 2): an agent self-registers, gets a
 * `claim_url`, and its human opens it, verifies with PayPal and claims
 * the agent.
 *
 * Tokens (Global Constraints, "Claim"): 32 bytes, base64url, stored only
 * as a sha256 hash, single-use, valid for 7 real days (wall clock, not
 * the simulated clock). So that `get_status` can keep showing the same
 * claim URL until the agent is claimed — without storing the token —
 * the token is HMAC-SHA256(secret, agent id + a random 32-byte seed),
 * and the row stores the seed and the token's hash. An expired,
 * unclaimed token is rotated (new seed, new 7 days) the next time the
 * agent asks for its link.
 *
 * Single use: a claim sets `principal_id` + `claimed_at` under the agent
 * row's lock and nulls the seed (the token can never be shown again);
 * the hash stays so the link resolves to "claimed by you" or "already
 * claimed" (409) instead of a bare "invalid link". A token whose agent
 * is claimed never claims it again, for anyone.
 *
 * Tokens are never logged: nothing here prints a token or a claim URL.
 */

export const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function deriveClaimToken(agentId: string, seed: string): string {
  return createHmac("sha256", sessionSecret())
    .update(`mandate-claim-token:v1:${agentId}:${seed}`, "utf8")
    .digest("base64url");
}

/** `${PUBLIC_BASE_URL}/claim/<token>`, falling back to `http://localhost:3000`. */
export function claimUrlForToken(token: string): string {
  const base = (process.env.PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/claim/${token}`;
}

export interface IssuedClaimToken {
  token: string;
  /** Columns to store on the agent row. */
  columns: { claimTokenHash: string; claimTokenSeed: string; claimExpiresAt: Date };
}

/** A fresh claim token for `agentId`, valid for 7 days from `now`. */
export function issueClaimToken(agentId: string, now: Date = new Date()): IssuedClaimToken {
  const seed = randomBytes(32).toString("base64url");
  const token = deriveClaimToken(agentId, seed);
  return {
    token,
    columns: {
      claimTokenHash: hashClaimToken(token),
      claimTokenSeed: seed,
      claimExpiresAt: new Date(now.getTime() + CLAIM_TTL_MS),
    },
  };
}

type AgentRow = typeof agents.$inferSelect;

export interface ClaimLink {
  url: string;
  expiresAt: Date;
}

/**
 * The agent's current claim link, or `null` once it is claimed. An
 * expired (or missing) token is rotated first, so the link returned is
 * always usable for at least a moment.
 */
export async function claimLinkForAgent(
  db: Db,
  worldId: string,
  agent: AgentRow,
  now: Date = new Date(),
): Promise<ClaimLink | null> {
  if (agent.principalId || agent.claimedAt) {
    return null;
  }
  if (agent.claimTokenSeed && agent.claimTokenHash && agent.claimExpiresAt && agent.claimExpiresAt > now) {
    const token = deriveClaimToken(agent.id, agent.claimTokenSeed);
    // A rotated SESSION_SECRET changes the derivation; rotate rather than show a dead link.
    if (hashClaimToken(token) === agent.claimTokenHash) {
      return { url: claimUrlForToken(token), expiresAt: agent.claimExpiresAt };
    }
  }

  const issued = issueClaimToken(agent.id, now);
  const updated = await scoped(db, worldId).update(
    agents,
    issued.columns,
    and(eq(agents.id, agent.id), isNull(agents.principalId), isNull(agents.claimedAt))!,
  );
  if (updated.length !== 1) {
    // Claimed concurrently.
    return null;
  }
  return { url: claimUrlForToken(issued.token), expiresAt: issued.columns.claimExpiresAt };
}

export interface ClaimAgentSummary {
  id: string;
  name: string;
  operator: string;
  model: string;
}

export type ClaimLookup =
  | { state: "invalid" }
  | { state: "expired"; agent: ClaimAgentSummary }
  | { state: "claimable"; agent: ClaimAgentSummary; expiresAt: Date }
  | { state: "claimed"; agent: ClaimAgentSummary; principalId: string };

function summary(agent: AgentRow): ClaimAgentSummary {
  return { id: agent.id, name: agent.name, operator: agent.operator, model: agent.model };
}

function classify(agent: AgentRow | undefined, now: Date): ClaimLookup {
  if (!agent) {
    return { state: "invalid" };
  }
  if (agent.principalId) {
    return { state: "claimed", agent: summary(agent), principalId: agent.principalId };
  }
  if (!agent.claimExpiresAt || agent.claimExpiresAt.getTime() <= now.getTime()) {
    return { state: "expired", agent: summary(agent) };
  }
  return { state: "claimable", agent: summary(agent), expiresAt: agent.claimExpiresAt };
}

/** What a claim link points at right now (read-only; for the claim page). */
export async function lookupClaim(db: Db, token: string, now: Date = new Date()): Promise<ClaimLookup> {
  if (!TOKEN_RE.test(token)) {
    return { state: "invalid" };
  }
  const { worldId } = await ensureMainWorldOnce(db);
  const agent = await scoped(db, worldId).findOne(agents, eq(agents.claimTokenHash, hashClaimToken(token)));
  return classify(agent, now);
}

export type ClaimOutcome =
  | { outcome: "claimed"; agent: ClaimAgentSummary }
  | { outcome: "already_yours"; agent: ClaimAgentSummary }
  | { outcome: "claimed_by_other" }
  | { outcome: "expired" }
  | { outcome: "invalid" }
  | { outcome: "principal_unverified" };

/**
 * Claims the agent behind `token` for `principalId`. Under the agent
 * row's lock: unclaimed + known + unexpired → set `principal_id` and
 * `claimed_at`, null the seed. A token whose agent is already claimed
 * never changes its owner.
 */
export async function claimAgent(
  db: Db,
  principalId: string,
  token: string,
  options: { now?: Date } = {},
): Promise<ClaimOutcome> {
  const now = options.now ?? new Date();
  if (!TOKEN_RE.test(token)) {
    return { outcome: "invalid" };
  }
  if (!/^[0-9a-f-]{36}$/i.test(principalId)) {
    return { outcome: "principal_unverified" };
  }
  const [principal] = await db.select().from(principals).where(eq(principals.id, principalId)).limit(1);
  if (!principal || !principal.verifiedAt) {
    return { outcome: "principal_unverified" };
  }
  const { worldId } = await ensureMainWorldOnce(db);
  const tokenHash = hashClaimToken(token);

  return db.transaction(async (tx) => {
    const [agent] = await scoped(tx, worldId).forUpdate(agents, eq(agents.claimTokenHash, tokenHash));
    const found = classify(agent, now);
    switch (found.state) {
      case "invalid":
        return { outcome: "invalid" } as const;
      case "claimed":
        return found.principalId === principalId
          ? ({ outcome: "already_yours", agent: found.agent } as const)
          : ({ outcome: "claimed_by_other" } as const);
      case "expired":
        return { outcome: "expired" } as const;
      case "claimable":
        break;
    }
    const updated = await scoped(tx, worldId).update(
      agents,
      { principalId, claimedAt: now, claimTokenSeed: null },
      and(eq(agents.id, found.agent.id), isNull(agents.principalId))!,
    );
    if (updated.length !== 1) {
      // Unreachable while we hold the row lock.
      throw new Error("Agent claim changed under its row lock");
    }
    return { outcome: "claimed", agent: found.agent } as const;
  });
}

/** What the claim page shows, from the link's state and who (if anyone) is signed in. */
export type ClaimView =
  | { view: "invalid" }
  | { view: "expired"; agent: ClaimAgentSummary }
  | { view: "sign_in"; agent: ClaimAgentSummary }
  | { view: "confirm"; agent: ClaimAgentSummary }
  | { view: "yours"; agent: ClaimAgentSummary }
  | { view: "taken"; agent: ClaimAgentSummary };

export async function claimView(
  db: Db,
  token: string,
  principalId: string | null,
  now: Date = new Date(),
): Promise<ClaimView> {
  const found = await lookupClaim(db, token, now);
  switch (found.state) {
    case "invalid":
      return { view: "invalid" };
    case "claimed":
      return found.principalId === principalId
        ? { view: "yours", agent: found.agent }
        : { view: "taken", agent: found.agent };
    case "expired":
      return { view: "expired", agent: found.agent };
    case "claimable":
      return principalId ? { view: "confirm", agent: found.agent } : { view: "sign_in", agent: found.agent };
  }
}
