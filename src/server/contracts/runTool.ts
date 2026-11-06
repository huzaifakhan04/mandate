import { createHash, randomUUID } from "crypto";

import { and, eq } from "drizzle-orm";

import type { AgentPrincipal } from "../auth/apiKeys";
import { verifyApiKey } from "../auth/apiKeys";
import { checkRequestSignature, parsePublicKey, type SignedRequest } from "../auth/signatures";
import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { describeError, isRetryableTransactionError } from "../db/errors";
import { scoped } from "../db/scoped";
import { agents, idempotencyKeys, worlds } from "../db/schema";
import { ensureMainWorldOnce } from "../services/worlds";
import type { Envelope } from "./envelope";
import { docsUrlForTool, fail, httpStatusForEnvelope } from "./envelope";
import { borrowBlockedEnvelope } from "./kyaActions";
import { activeAgentKey, recordSignatureNonce } from "../auth/agentKeys";
import { borrowGate } from "../services/kya";
import type { ToolDef } from "./registry";

export interface RunToolDeps {
  getDb: () => Promise<Db>;
  /** The raw `Authorization` header, e.g. `Bearer mnd_...` or the bare key. */
  authorization?: string | null;
  /** The idempotency key, from the `Idempotency-Key` header. */
  idempotencyKey?: string | null;
  /**
   * P2 Task 3: the HTTP request facts a signature covers (method, path,
   * the exact raw body) plus the `X-Mandate-*` signature headers. Absent
   * means "unsigned": fine for an agent without a signing key, a 401
   * `SIGNATURE_REQUIRED` on a mutating call from one with a key.
   */
  request?: SignedRequest | null;
  requestId?: string;
  /**
   * P2 Task 6, server-internal only (the private-world bot runner): act
   * as this bot agent without an API key. Only an agent row with
   * `is_bot = true` is accepted (anything else → 401); HTTP and MCP
   * routes never set it, and bots have no API keys, so nothing outside
   * the server can drive a bot.
   */
  actingBotId?: string | null;
}

export interface RunToolResult {
  httpStatus: number;
  envelope: Envelope<unknown>;
}

/**
 * Thrown inside the claim-first transaction when this call lost the race
 * for an idempotency key (someone else's row already holds/held it).
 * Caught by `runTool` to resolve the outcome after rollback — never
 * propagates past `runTool`.
 */
class IdempotencyClaimLost extends Error {}

/**
 * M8 (final review): runs `attempt` (one whole transaction) and, if it
 * failed with a Postgres deadlock (`40P01`) or serialization failure
 * (`40001`), runs it ONCE more in a fresh transaction — Postgres rolled the
 * first one back entirely, so nothing it did is visible. Any other error,
 * or a second retryable failure, propagates (→ INTERNAL_ERROR).
 */
async function withTransactionRetry<T>(
  toolName: string,
  requestId: string,
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (!isRetryableTransactionError(err)) {
      throw err;
    }
    console.warn(`[runTool] ${toolName} retrying after ${describeError(err)} (requestId=${requestId})`);
    return attempt();
  }
}

/**
 * Builds a `RunToolResult` whose HTTP status is derived from the envelope.
 * With `toolName` (every call site once a tool has been resolved), rewrites
 * `docs_url` to that tool's own `/agents.md#<tool-name>` anchor — fixes M1
 * so every response points an agent at the documentation for the call it
 * just made, not just the top of the page.
 */
function respond(envelope: Envelope<unknown>, toolName?: string): RunToolResult {
  const finalEnvelope = toolName ? withDocsAnchor(envelope, toolName) : envelope;
  return { httpStatus: httpStatusForEnvelope(finalEnvelope), envelope: finalEnvelope };
}

/**
 * Re-points an already-built envelope's `docs_url` at `toolName`'s own
 * `/agents.md` anchor. Applied to every handler/finalize result (not just
 * the final response) so a stored idempotency-replay row also carries the
 * tool-specific anchor, not the generic one `ok`/`fail` set by default.
 */
function withDocsAnchor(envelope: Envelope<unknown>, toolName: string): Envelope<unknown> {
  return { ...envelope, docs_url: docsUrlForTool(toolName) };
}

/** P2 Task 6: the bot agent `agentId` as a principal, or `null` if it isn't a bot. */
async function botPrincipal(db: Db, agentId: string): Promise<AgentPrincipal | null> {
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) {
    return null;
  }
  const [row] = await db
    .select({ agentId: agents.id, worldId: agents.worldId, status: agents.status })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.isBot, true)))
    .limit(1);
  return row ?? null;
}

async function worldIsActive(db: Db, worldId: string): Promise<boolean> {
  const [row] = await db.select({ status: worlds.status }).from(worlds).where(eq(worlds.id, worldId)).limit(1);
  return row?.status === "active";
}

/** Strips an optional `Bearer ` prefix from an `Authorization` header value. */
function extractApiKey(authorization: string): string {
  const trimmed = authorization.trim();
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(trimmed);
  return bearerMatch ? bearerMatch[1]!.trim() : trimmed;
}

/**
 * Deterministically stringifies a value with object keys sorted, so the
 * same logical input always hashes the same way regardless of key order.
 * `bigint` (money fields are `bigint` cents throughout this codebase) is
 * serialised as its decimal string with a trailing `n` — plain
 * `JSON.stringify` throws on a bare `bigint`, and a future mutating tool's
 * validated input may contain one.
 */
function stableStringify(value: unknown): string {
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashRequest(toolName: string, input: unknown): string {
  return createHash("sha256").update(`${toolName}:${stableStringify(input)}`).digest("hex");
}

/**
 * Pulls `idempotency_key` out of a raw object input (if present and a
 * string), returning the stripped object and the extracted key. This runs
 * before Zod validation so a tool's input schema never needs to know about
 * idempotency, and a strict-object schema doesn't reject the key as
 * unrecognized.
 */
function extractIdempotencyKeyArg(rawInput: unknown): { input: unknown; key: string | null } {
  if (
    typeof rawInput !== "object" ||
    rawInput === null ||
    Array.isArray(rawInput) ||
    !("idempotency_key" in rawInput)
  ) {
    return { input: rawInput, key: null };
  }

  const { idempotency_key, ...rest } = rawInput as Record<string, unknown>;
  return {
    input: rest,
    key: typeof idempotency_key === "string" ? idempotency_key : null,
  };
}

/**
 * P2 Task 3: the request-signature gate for a mutating call from `agent`.
 * Returns an error envelope to send back, or `null` to proceed.
 *
 * - Normally the signature must verify against the agent's active key;
 *   with no active key, the call needs no signature.
 * - `register_public_key` (`tool.signingKeyFromInput`) must be signed by
 *   the key it registers (proof of possession); rotating away from a
 *   different active key also needs `X-Mandate-Previous-Signature` from
 *   that current key, so a stolen API key alone can't swap the key.
 * - A verified signature is recorded as a nonce first; one already seen
 *   for this agent → `SIGNATURE_REPLAYED`. This runs before idempotency,
 *   so a retry must be re-signed (fresh timestamp) and is then replayed
 *   from its `Idempotency-Key` — a replayed signature never executes.
 */
async function signatureGate(
  db: Db,
  worldId: string,
  agentId: string,
  tool: ToolDef,
  input: unknown,
  request: SignedRequest | null,
): Promise<Envelope<unknown> | null> {
  const active = await activeAgentKey(db, worldId, agentId);
  let expectedKey = active?.publicKey ?? null;
  let previousKey: string | null = null;

  if (tool.signingKeyFromInput) {
    const parsed = parsePublicKey(tool.signingKeyFromInput(input as never));
    if (!parsed.ok) {
      return fail("INVALID_REQUEST", "public_key must be a base64 Ed25519 public key (raw 32 bytes or SPKI DER).", [
        "invalid_public_key",
        parsed.reason,
      ]);
    }
    expectedKey = parsed.rawB64;
    if (active && active.publicKey !== parsed.rawB64) {
      previousKey = active.publicKey;
    }
  }

  if (!expectedKey) {
    return null;
  }

  const now = new Date();
  const check = checkRequestSignature(request, expectedKey, now);
  if (!check.ok) {
    return signatureFailure(check.status, check.reason);
  }
  if (previousKey) {
    const previous = checkRequestSignature(request, previousKey, now, "previousSignature");
    if (!previous.ok) {
      return signatureFailure(previous.status, previous.reason);
    }
  }
  if (!(await recordSignatureNonce(db, worldId, agentId, check.signatureB64, now))) {
    return fail("SIGNATURE_REPLAYED", "This signature was already used. Sign each request afresh.", ["signature_replayed"]);
  }
  return null;
}

const SIGNATURE_SUMMARIES: Record<string, string> = {
  SIGNATURE_REQUIRED: "This agent has a signing key: sign mutating requests (X-Mandate-Timestamp, X-Mandate-Signature).",
  SIGNATURE_INVALID: "The request signature does not verify against this agent's signing key.",
  SIGNATURE_EXPIRED: "X-Mandate-Timestamp is more than 300 seconds from the server's clock.",
};

function signatureFailure(status: string, reason: string): Envelope<unknown> {
  return fail(status, SIGNATURE_SUMMARIES[status] ?? "Request signature rejected.", [reason]);
}

/**
 * The single dispatch path shared by REST and MCP:
 *
 * 1. Unknown tool → 404 `NOT_FOUND`.
 * 2. `auth: 'agent'` tools resolve the caller from `authorization` (a
 *    missing/invalid/revoked key → 401 `UNAUTHORIZED`); the tool's world is
 *    the agent's world. `auth: 'none'` tools run against the (memoised)
 *    main world, with `ctx.agent`/`ctx.agentId` left `null`.
 * 3. The `Idempotency-Key` header and an `idempotency_key` input arg must
 *    agree if both are present (→ 400 `INVALID_REQUEST`,
 *    `idempotency_key_mismatch`). The arg is then stripped and the rest
 *    validated against the tool's Zod schema → 400 `INVALID_REQUEST` on
 *    failure.
 * 4. A mutating call from an agent passes the signature gate (P2 Task 3,
 *    `signatureGate`: 401 `SIGNATURE_REQUIRED`/`_INVALID`/`_EXPIRED`/
 *    `_REPLAYED`), then one whose agent has `status !== 'active'` → 403
 *    `AGENT_NOT_ACTIVE` — except that a `frozen`/`restricted` agent may
 *    still call the money-in tools (`MONEY_IN_TOOLS`: repaying a loan and
 *    capturing an approved checkout), so freezing never traps a debt; a
 *    borrowing tool then checks the KYA tier.
 * 5. Mutating tools run inside a `db.transaction`. When the caller is an
 *    authenticated agent AND an idempotency key is present, the key is
 *    handled with a claim-first protocol that stays correct under
 *    concurrent identical requests (see the inline comment below for the
 *    full protocol): replay on a matching hash, 409
 *    `IDEMPOTENCY_CONFLICT` on a mismatched hash, otherwise the handler
 *    runs and the row is filled in with the real response in the same
 *    transaction. For `auth: 'none'` mutating tools (no agent to
 *    attribute `idempotency_keys.agent_id` to, which is `NOT NULL`)
 *    idempotency is ignored entirely — the handler just runs normally
 *    inside the transaction, key or no key.
 * 6. After the transaction commits (or, for `readOnly` tools, right after
 *    the handler returns), every `ctx.afterCommit` callback registered
 *    during the call runs in order; a callback that throws is logged and
 *    does not change the envelope. Callbacks do not run on an idempotent
 *    replay, nor when the transaction rolled back.
 * 7. A mutating call's transaction that fails with a Postgres deadlock
 *    (`40P01`) or serialization failure (`40001`) is retried once, whole,
 *    in a fresh transaction (same idempotency-key path) before giving up.
 * 8. Any other thrown error (from `getDb`, world/clock setup, auth, or the
 *    handler itself) → 500 `INTERNAL_ERROR`, logged server-side with
 *    `requestId` as name/SQLSTATE/message only (never query text or
 *    params) and never leaking its message/stack to the caller.
 *
 * Every returned/stored/replayed HTTP status is derived from its
 * envelope's `status` via `httpStatusForEnvelope` — never hard-coded.
 */
/**
 * P2 final review (M4): tools that only bring money INTO the bank —
 * `repay_loan` (start a repayment checkout) and `confirm_checkout`
 * (capture one the human already approved). A frozen or restricted agent
 * may still call them: freezing stops new borrowing, lending and
 * redemptions, but must never stop a debt being repaid. A revoked agent
 * (or one pending its claim) may not.
 */
export const MONEY_IN_TOOLS: ReadonlySet<string> = new Set(["repay_loan", "confirm_checkout"]);
const MONEY_IN_STATUSES: ReadonlySet<string> = new Set(["frozen", "restricted"]);

function mayBringMoneyIn(status: string, toolName: string): boolean {
  return MONEY_IN_STATUSES.has(status) && MONEY_IN_TOOLS.has(toolName);
}

export async function runTool(
  tool: ToolDef | undefined,
  toolName: string,
  rawInput: unknown,
  {
    getDb,
    authorization = null,
    idempotencyKey = null,
    request = null,
    requestId = randomUUID(),
    actingBotId = null,
  }: RunToolDeps,
): Promise<RunToolResult> {
  if (!tool) {
    return respond(fail("NOT_FOUND", `Unknown tool: ${toolName}`, [toolName]));
  }

  try {
    const db = await getDb();

    let agent: AgentPrincipal | null = null;
    let worldId: string;

    if (tool.auth === "agent") {
      if (actingBotId) {
        agent = await botPrincipal(db, actingBotId);
        if (!agent) {
          return respond(fail("UNAUTHORIZED", "Not a bot agent.", ["not_a_bot"]), toolName);
        }
      } else {
        if (!authorization) {
          return respond(fail("UNAUTHORIZED", "Missing API key.", ["missing_api_key"]), toolName);
        }

        const presentedKey = extractApiKey(authorization);
        agent = await verifyApiKey(db, presentedKey);
        if (!agent) {
          return respond(fail("UNAUTHORIZED", "Invalid API key.", ["invalid_api_key"]), toolName);
        }
      }

      worldId = agent.worldId;
      // P2 Task 6: a reset private world is archived — its agents stop.
      if (!(await worldIsActive(db, worldId))) {
        return respond(
          fail("WORLD_ARCHIVED", "This agent's sandbox world was reset or archived.", ["world_archived"]),
          toolName,
        );
      }
    } else {
      const mainWorld = await ensureMainWorldOnce(db);
      worldId = mainWorld.worldId;
    }

    const simNow = await getSimNow(db, worldId);

    const { input: strippedInput, key: bodyIdempotencyKey } = extractIdempotencyKeyArg(rawInput);

    if (idempotencyKey && bodyIdempotencyKey && idempotencyKey !== bodyIdempotencyKey) {
      return respond(
        fail(
          "INVALID_REQUEST",
          "The Idempotency-Key header and the idempotency_key argument disagree.",
          ["idempotency_key_mismatch"],
        ),
        toolName,
      );
    }
    const effectiveIdempotencyKey = idempotencyKey ?? bodyIdempotencyKey;

    const parsed = tool.input.safeParse(strippedInput);
    if (!parsed.success) {
      const reasonCodes = parsed.error.issues.flatMap((issue) => {
        if (issue.code === "unrecognized_keys") {
          return issue.keys.map((key) => `unrecognized_key:${key}`);
        }
        return [issue.path.join(".") || "root"];
      });
      return respond(fail("INVALID_REQUEST", "Invalid input.", reasonCodes), toolName);
    }

    // P2 Task 3: signed mutating requests (never stored under an idempotency key).
    if (tool.mutating && agent) {
      const rejected = await signatureGate(db, worldId, agent.agentId, tool, parsed.data, request);
      if (rejected) {
        return respond(rejected, toolName);
      }
    }

    if (tool.mutating && agent && agent.status !== "active" && !mayBringMoneyIn(agent.status, tool.name)) {
      return respond(fail("AGENT_NOT_ACTIVE", "This agent is not active.", ["agent_not_active"]), toolName);
    }

    // P2 Task 2: KYA tier gate for borrowing tools — never stored under an
    // idempotency key (the 403 carries the agent's claim URL).
    if (tool.requiresBorrowTier && agent) {
      const gate = await borrowGate(db, worldId, agent.agentId);
      if (gate.tier.borrowBlockers.length > 0) {
        return respond(borrowBlockedEnvelope(gate.tier.borrowBlockers, gate.claimLink?.url ?? null), toolName);
      }
    }

    const afterCommitCallbacks: Array<() => Promise<void> | void> = [];
    function afterCommit(fn: () => Promise<void> | void): void {
      afterCommitCallbacks.push(fn);
    }

    // Fix round 1, I2b: `handler` can stash bookkeeping here for an
    // optional `finalize` hook, out-of-band from the envelope `handler`
    // itself returns — so that envelope stays a clean, public, safely
    // replayable fallback on its own (no smuggled internal fields).
    let finalizeState: unknown;
    function setFinalizeState(state: unknown): void {
      finalizeState = state;
    }

    // M8: a retried transaction starts from scratch — callbacks and
    // finalize state registered by a rolled-back attempt must not run.
    function resetAttemptState(): void {
      afterCommitCallbacks.length = 0;
      finalizeState = undefined;
      claimedIdempotencyRowId = null;
    }

    // Ruling L: a tool can opt out of the claim-first idempotency
    // protocol entirely (mutating tools opt in by default).
    const usesIdempotencyProtocol = tool.idempotent !== false;

    let envelope: Envelope<unknown>;
    // Set only on the path that actually claimed an idempotency row and
    // ran the handler in this call (never on a replay) — `finalize`
    // (below) uses it to know which stored row, if any, to overwrite
    // with the finalized envelope.
    let claimedIdempotencyRowId: string | null = null;

    if (tool.mutating) {
      if (agent && effectiveIdempotencyKey && usesIdempotencyProtocol) {
        const agentId = agent.agentId;
        const requestHash = hashRequest(toolName, parsed.data);

        try {
          envelope = await withTransactionRetry(toolName, requestId, () =>
            db.transaction(async (tx) => {
              resetAttemptState();
              // Claim-first idempotency, race-safe under concurrent calls
              // sharing the same key: this INSERT is the only write that
              // decides who "wins" a fresh key. Postgres (and PGlite) blocks
              // a conflicting `INSERT ... ON CONFLICT DO NOTHING` against an
              // uncommitted row with the same unique key until the other
              // transaction commits or rolls back — so by the time this
              // resolves, the outcome is final, not a transient snapshot.
              const claimed = await tx
                .insert(idempotencyKeys)
                .values({
                  worldId,
                  agentId,
                  key: effectiveIdempotencyKey,
                  requestHash,
                  response: null,
                  httpStatus: null,
                })
                .onConflictDoNothing({
                  target: [idempotencyKeys.worldId, idempotencyKeys.agentId, idempotencyKeys.key],
                })
                .returning();

              if (claimed.length === 0) {
                // Lost the race (or the key already existed from an earlier
                // call). Abort this transaction without running the
                // handler — resolved in the catch block below, against
                // whatever is now committed.
                throw new IdempotencyClaimLost();
              }

              const claimedId = claimed[0]!.id;

              const result = withDocsAnchor(
                await tool.handler(parsed.data, {
                  worldId,
                  simNow,
                  agentId,
                  agent,
                  requestId,
                  db,
                  tx,
                  scoped: scoped(tx, worldId),
                  afterCommit,
                  setFinalizeState,
                }),
                toolName,
              );

              await tx
                .update(idempotencyKeys)
                .set({ response: result, httpStatus: httpStatusForEnvelope(result) })
                .where(eq(idempotencyKeys.id, claimedId));

              claimedIdempotencyRowId = claimedId;
              return result;
            }),
          );
        } catch (err) {
          if (!(err instanceof IdempotencyClaimLost)) {
            throw err;
          }

          const [existing] = await db
            .select()
            .from(idempotencyKeys)
            .where(
              and(
                eq(idempotencyKeys.worldId, worldId),
                eq(idempotencyKeys.agentId, agentId),
                eq(idempotencyKeys.key, effectiveIdempotencyKey),
              ),
            )
            .limit(1);

          if (!existing || existing.response === null || existing.httpStatus === null) {
            // Defensive only: the block-until-commit-or-rollback behavior
            // of the conflicting INSERT above means the row is always
            // either fully committed (response + httpStatus set) or gone
            // (rolled back) by the time we get here — this shouldn't be
            // reachable in practice.
            return respond(
              fail(
                "IDEMPOTENCY_IN_PROGRESS",
                "This idempotency key is still being processed by another request.",
                ["idempotency_key_in_progress"],
              ),
              toolName,
            );
          }

          if (existing.requestHash !== requestHash) {
            return respond(
              fail(
                "IDEMPOTENCY_CONFLICT",
                "This idempotency key was already used with different input.",
                ["idempotency_key_conflict"],
              ),
              toolName,
            );
          }

          // Replay: return the stored envelope/status verbatim. Do NOT
          // run afterCommit callbacks — nothing new happened in this call.
          return { httpStatus: existing.httpStatus, envelope: existing.response as Envelope<unknown> };
        }
      } else {
        // No idempotency key, or `auth: 'none'` (no agent to attribute an
        // idempotency row to — `idempotency_keys.agent_id` is NOT NULL,
        // so per ruling idempotency is ignored entirely here: the handler
        // still runs inside a transaction, but nothing is stored, even if
        // a key was supplied).
        envelope = withDocsAnchor(
          await withTransactionRetry(toolName, requestId, () =>
            db.transaction((tx) => {
              resetAttemptState();
              return tool.handler(parsed.data, {
                worldId,
                simNow,
                agentId: agent?.agentId ?? null,
                agent,
                requestId,
                db,
                tx,
                scoped: scoped(tx, worldId),
                afterCommit,
                setFinalizeState,
              });
            }),
          ),
          toolName,
        );
      }
    } else {
      envelope = withDocsAnchor(
        await tool.handler(parsed.data, {
          worldId,
          simNow,
          agentId: agent?.agentId ?? null,
          agent,
          requestId,
          db,
          tx: db,
          scoped: scoped(db, worldId),
          afterCommit,
          setFinalizeState,
        }),
        toolName,
      );
    }

    for (const callback of afterCommitCallbacks) {
      try {
        await callback();
      } catch (err) {
        console.error(`[runTool] ${toolName} afterCommit callback failed (requestId=${requestId}): ${describeError(err)}`);
      }
    }

    if (tool.finalize) {
      // Fix round 1, I2c: handler's own envelope is already a safe,
      // public, replayable fallback (and, when an idempotency row was
      // claimed, it's exactly what's currently stored there) — if
      // `finalize` throws, log it and keep that fallback rather than
      // inventing a generic `INTERNAL_ERROR` or touching the stored row.
      const preFinalizeEnvelope = envelope;
      try {
        envelope = withDocsAnchor(
          await tool.finalize(
            envelope,
            { worldId, simNow, agentId: agent?.agentId ?? null, agent, requestId, db },
            finalizeState,
          ),
          toolName,
        );
      } catch (err) {
        console.error(`[runTool] ${toolName} finalize failed (requestId=${requestId}): ${describeError(err)}`);
        envelope = preFinalizeEnvelope;
        return respond(envelope);
      }

      // The finalized envelope, not handler's pre-finalize one, is what
      // idempotent replays of this key must return. A failure to persist
      // this is logged and otherwise ignored — the caller still gets the
      // (correct, just-computed) finalized envelope this call; a replay
      // would see the stale pre-finalize one, which is a lesser issue
      // than failing this response outright.
      if (claimedIdempotencyRowId) {
        try {
          await db
            .update(idempotencyKeys)
            .set({ response: envelope, httpStatus: httpStatusForEnvelope(envelope) })
            .where(eq(idempotencyKeys.id, claimedIdempotencyRowId));
        } catch (err) {
          console.error(
            `[runTool] ${toolName} failed to persist the finalized envelope (requestId=${requestId}): ${describeError(err)}`,
          );
        }
      }
    }

    return respond(envelope);
  } catch (err) {
    // M12: logged server-side as name/SQLSTATE/message only (never a
    // Drizzle error's query text or bound params), keyed by requestId.
    // Callers/clients only ever see the generic message below.
    console.error(`[runTool] ${toolName} failed (requestId=${requestId}): ${describeError(err)}`);

    return respond(
      fail(
        "INTERNAL_ERROR",
        `Something went wrong handling this request. (request_id: ${requestId})`,
        ["internal_error"],
        { request_id: requestId },
      ),
      toolName,
    );
  }
}
