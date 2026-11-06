import { and, eq, inArray, isNull } from "drizzle-orm";

import { generateApiKey } from "../auth/apiKeys";
import { ownedAgent } from "../auth/ownership";
import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { agentKeys, agents, apiKeys, events } from "../db/schema";
import { scoped } from "../db/scoped";
import { registerAgent } from "./agents";
import { ownedPrivateWorld } from "./privateWorldAccess";
import { ensureMainWorldOnce } from "./worlds";

/**
 * Owner actions on agents (P2 Task 5), called by the dashboard's routes
 * (`src/server/auth/ownerRoutes.ts`). Every action that names an agent
 * first checks the principal claimed it (`ownedAgent`): anyone else's
 * agent, an unknown id and a malformed one are all `not_found` (Review
 * Focus 3). Each change appends an `agent.*` event.
 */

type OwnerEventType =
  | "agent.registered_by_owner"
  | "agent.frozen"
  | "agent.unfrozen"
  | "agent.signing_key_revoked"
  | "agent.api_key_rotated";

async function appendAgentEvent(
  tx: Db,
  worldId: string,
  type: OwnerEventType,
  agentId: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await scoped(tx, worldId).insert(events, {
    type,
    aggregateType: "agent",
    aggregateId: agentId,
    payload: { agent_id: agentId, by: "owner", ...payload },
    occurredSimAt: await getSimNow(tx, worldId),
  });
}

// ---------------------------------------------------------------------
// Path B: the human registers an agent in the dashboard
// ---------------------------------------------------------------------

export interface OwnerRegisterInput {
  name: string;
  operator: string;
  model: string;
  payoutEmail?: string;
  payoutPaypalId?: string;
}

export type OwnerRegisterField = "name" | "operator" | "model" | "payout";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAYPAL_ID_RE = /^[A-Z0-9]{13}$/;

/**
 * Pure: the register form's fields. `payout` is a PayPal email or a
 * 13-character PayPal payer ID (the same rules as `register_agent`).
 */
export function parseOwnerRegisterInput(
  raw: Record<string, unknown>,
): { ok: true; input: OwnerRegisterInput } | { ok: false; errors: OwnerRegisterField[] } {
  const text = (value: unknown) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "");
  const name = text(raw.name);
  const operator = text(raw.operator);
  const model = text(raw.model);
  const payout = text(raw.payout).replace(/\s/g, "");
  const errors: OwnerRegisterField[] = [];
  if (name.length < 2 || name.length > 60) errors.push("name");
  if (operator.length < 1 || operator.length > 80) errors.push("operator");
  if (model.length < 1 || model.length > 80) errors.push("model");
  const isEmail = payout.length <= 254 && EMAIL_RE.test(payout);
  const isPaypalId = PAYPAL_ID_RE.test(payout.toUpperCase()) && !payout.includes("@");
  if (!isEmail && !isPaypalId) errors.push("payout");
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    input: {
      name,
      operator,
      model,
      ...(isEmail ? { payoutEmail: payout } : { payoutPaypalId: payout.toUpperCase() }),
    },
  };
}

export interface OwnerRegistered {
  outcome: "registered";
  agentId: string;
  worldId: string;
  /** Shown to the owner once; never stored. */
  apiKey: string;
}

/**
 * Creates an agent already claimed by `principalId`: status `active`,
 * tier 0 until the owner signs a mandate. No claim token is left on the
 * row — there is nobody else to hand it to. The agent (and its key) is
 * bound to the main world, or (P2 Task 6) to `options.worldId` when that
 * is one of the principal's own active private worlds — any other world
 * → `world_not_found`.
 */
export async function registerOwnedAgent(
  db: Db,
  principalId: string,
  input: OwnerRegisterInput,
  now?: Date,
): Promise<OwnerRegistered>;
export async function registerOwnedAgent(
  db: Db,
  principalId: string,
  input: OwnerRegisterInput,
  now: Date,
  options: { worldId?: string | null },
): Promise<OwnerRegistered | { outcome: "world_not_found" }>;
export async function registerOwnedAgent(
  db: Db,
  principalId: string,
  input: OwnerRegisterInput,
  now: Date = new Date(),
  options: { worldId?: string | null } = {},
): Promise<OwnerRegistered | { outcome: "world_not_found" }> {
  const { worldId: mainWorldId } = await ensureMainWorldOnce(db);
  let worldId = mainWorldId;
  if (options.worldId && options.worldId !== mainWorldId) {
    const world = await ownedPrivateWorld(db, principalId, options.worldId);
    if (!world) {
      return { outcome: "world_not_found" };
    }
    worldId = world.id;
  }
  return db.transaction(async (tx) => {
    const registered = await registerAgent(
      tx,
      worldId,
      {
        name: input.name,
        operator: input.operator,
        model: input.model,
        payoutEmail: input.payoutEmail,
        payoutPaypalId: input.payoutPaypalId,
      },
      now,
    );
    const claimed = await scoped(tx, worldId).update(
      agents,
      { principalId, claimedAt: now, claimTokenHash: null, claimTokenSeed: null, claimExpiresAt: null },
      and(eq(agents.id, registered.agentId), isNull(agents.principalId))!,
    );
    if (claimed.length !== 1) {
      throw new Error(`Expected to claim the agent ${registered.agentId} just registered`);
    }
    await appendAgentEvent(tx, worldId, "agent.registered_by_owner", registered.agentId);
    return { outcome: "registered", agentId: registered.agentId, worldId, apiKey: registered.apiKey } as const;
  });
}

// ---------------------------------------------------------------------
// Freeze / unfreeze
// ---------------------------------------------------------------------

export type FreezeOutcome = "frozen" | "unfrozen" | "not_found" | "conflict";

/**
 * Freezes (`active`/`restricted` → `frozen`) or unfreezes (`frozen` →
 * `active`) the owner's agent. A frozen agent's mutating tool calls get
 * 403 `AGENT_NOT_ACTIVE` (runTool); its loans and notes are untouched.
 * Any other starting status → `conflict`.
 */
export async function setAgentFrozen(
  db: Db,
  params: { principalId: string; agentId: string; frozen: boolean },
): Promise<FreezeOutcome> {
  const agent = await ownedAgent(db, params.principalId, params.agentId);
  if (!agent) {
    return "not_found";
  }
  const from = params.frozen ? ["active", "restricted"] : ["frozen"];
  return db.transaction(async (tx) => {
    const updated = await scoped(tx, agent.worldId).update(
      agents,
      { status: params.frozen ? "frozen" : "active" },
      and(eq(agents.id, agent.id), eq(agents.principalId, params.principalId), inArray(agents.status, from))!,
    );
    if (updated.length === 0) {
      return "conflict" as const;
    }
    await appendAgentEvent(tx, agent.worldId, params.frozen ? "agent.frozen" : "agent.unfrozen", agent.id);
    return params.frozen ? ("frozen" as const) : ("unfrozen" as const);
  });
}

// ---------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------

export type RevokeSigningKeyOutcome = "revoked" | "not_found" | "no_key";

/**
 * Revokes the agent's active Ed25519 signing key (owner action, e.g. a
 * leaked private key). The agent drops from T2 to T1 at once (the tier is
 * computed); it can register a new key with `register_public_key`.
 */
export async function revokeSigningKey(
  db: Db,
  params: { principalId: string; agentId: string; now?: Date },
): Promise<RevokeSigningKeyOutcome> {
  const agent = await ownedAgent(db, params.principalId, params.agentId);
  if (!agent) {
    return "not_found";
  }
  const now = params.now ?? new Date();
  return db.transaction(async (tx) => {
    const revoked = await scoped(tx, agent.worldId).update(
      agentKeys,
      { revokedAt: now },
      and(eq(agentKeys.agentId, agent.id), isNull(agentKeys.revokedAt))!,
    );
    if (revoked.length === 0) {
      return "no_key" as const;
    }
    await appendAgentEvent(tx, agent.worldId, "agent.signing_key_revoked", agent.id, {
      key_ids: revoked.map((key) => key.id),
    });
    return "revoked" as const;
  });
}

export type RotateApiKeyOutcome = { outcome: "rotated"; apiKey: string } | { outcome: "not_found" } | { outcome: "conflict" };

/**
 * Issues the agent a new API key and revokes every older one in the same
 * transaction. The new key is returned once (to show the owner) and only
 * its hash is stored. A revoked agent can't be given a key (`conflict`).
 */
export async function rotateApiKey(
  db: Db,
  params: { principalId: string; agentId: string; now?: Date },
): Promise<RotateApiKeyOutcome> {
  const agent = await ownedAgent(db, params.principalId, params.agentId);
  if (!agent) {
    return { outcome: "not_found" };
  }
  const now = params.now ?? new Date();
  return db.transaction(async (tx) => {
    const [locked] = await scoped(tx, agent.worldId).forUpdate(
      agents,
      and(eq(agents.id, agent.id), eq(agents.principalId, params.principalId))!,
    );
    if (!locked) {
      return { outcome: "not_found" } as const;
    }
    if (locked.status === "revoked") {
      return { outcome: "conflict" } as const;
    }
    const revoked = await scoped(tx, agent.worldId).update(
      apiKeys,
      { revokedAt: now },
      and(eq(apiKeys.agentId, agent.id), isNull(apiKeys.revokedAt))!,
    );
    const generated = generateApiKey();
    await scoped(tx, agent.worldId).insert(apiKeys, {
      agentId: agent.id,
      prefix: generated.prefix,
      keyHash: generated.hash,
      createdAt: now,
    });
    await appendAgentEvent(tx, agent.worldId, "agent.api_key_rotated", agent.id, {
      revoked_prefixes: revoked.map((key) => key.prefix),
      prefix: generated.prefix,
    });
    return { outcome: "rotated", apiKey: generated.key } as const;
  });
}
