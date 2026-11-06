import { and, eq, isNull, lt, ne } from "drizzle-orm";

import { NONCE_RETENTION_MS } from "./signatures";
import type { Db } from "../db/client";
import { agentKeys, agentSignatureNonces } from "../db/schema";
import { scoped } from "../db/scoped";

/**
 * Agent signing keys and seen-signature nonces (P2 Task 3) — auth
 * infrastructure, like API keys. See `signatures.ts` for the signing
 * scheme and `runTool` for where it is enforced.
 */

export type AgentKeyRow = typeof agentKeys.$inferSelect;

/** The agent's active (unrevoked) signing key, or `undefined`. */
export async function activeAgentKey(db: Db, worldId: string, agentId: string): Promise<AgentKeyRow | undefined> {
  return scoped(db, worldId).findOne(agentKeys, and(eq(agentKeys.agentId, agentId), isNull(agentKeys.revokedAt))!);
}

export interface RegisteredKey {
  key: AgentKeyRow;
  /** An older active key was revoked by this registration. */
  rotated: boolean;
}

/**
 * Makes `publicKeyB64` (raw 32 bytes, base64) the agent's one active key:
 * a no-op when it already is; otherwise the old active key (if any) is
 * revoked first. Run inside the caller's transaction with the agent row
 * locked so concurrent registrations serialise (the partial unique index
 * `agent_keys_one_active_idx` is the backstop).
 */
export async function registerAgentKey(
  tx: Db,
  worldId: string,
  agentId: string,
  publicKeyB64: string,
  now: Date = new Date(),
): Promise<RegisteredKey> {
  const current = await activeAgentKey(tx, worldId, agentId);
  if (current && current.publicKey === publicKeyB64) {
    return { key: current, rotated: false };
  }
  const revoked = await scoped(tx, worldId).update(
    agentKeys,
    { revokedAt: now },
    and(eq(agentKeys.agentId, agentId), isNull(agentKeys.revokedAt), ne(agentKeys.publicKey, publicKeyB64))!,
  );
  const [key] = await scoped(tx, worldId).insert(agentKeys, { agentId, publicKey: publicKeyB64, alg: "ed25519", createdAt: now });
  if (!key) {
    throw new Error("Expected an agent_keys row to be inserted");
  }
  return { key, rotated: revoked.length > 0 };
}

/**
 * Records a seen signature. `false` when this agent already used it — a
 * replay. The unique `(agent_id, signature)` index decides concurrent
 * duplicates: exactly one insert wins.
 */
export async function recordSignatureNonce(
  db: Db,
  worldId: string,
  agentId: string,
  signatureB64: string,
  now: Date = new Date(),
): Promise<boolean> {
  const inserted = await scoped(db, worldId).insertOnConflictDoNothing(
    agentSignatureNonces,
    { agentId, signature: signatureB64, seenAt: now },
    [agentSignatureNonces.agentId, agentSignatureNonces.signature],
  );
  return inserted.length > 0;
}

/**
 * Deletes nonces older than the replay window (every world — a
 * maintenance sweep, like the reconcile cron's world listing). A
 * signature's timestamp is within ±300 s of when it was first seen, so
 * after 10 minutes it is expired and can no longer be replayed anyway.
 */
export async function pruneSignatureNonces(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - NONCE_RETENTION_MS);
  const deleted = await db
    .delete(agentSignatureNonces)
    .where(lt(agentSignatureNonces.seenAt, cutoff))
    .returning();
  return deleted.length;
}
