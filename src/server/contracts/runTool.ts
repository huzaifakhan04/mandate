import { createHash, randomUUID } from "crypto";

import { and, eq } from "drizzle-orm";

import type { AgentPrincipal } from "../auth/apiKeys";
import { verifyApiKey } from "../auth/apiKeys";
import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { scoped } from "../db/scoped";
import { idempotencyKeys } from "../db/schema";
import { ensureMainWorldOnce } from "../services/worlds";
import type { Envelope } from "./envelope";
import { fail, httpStatusForEnvelope } from "./envelope";
import type { ToolDef } from "./registry";

export interface RunToolDeps {
  getDb: () => Promise<Db>;
  /** The raw `Authorization` header, e.g. `Bearer mnd_...` or the bare key. */
  authorization?: string | null;
  /** The idempotency key, from the `Idempotency-Key` header. */
  idempotencyKey?: string | null;
  requestId?: string;
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

/** Builds a `RunToolResult` whose HTTP status is derived from the envelope. */
function respond(envelope: Envelope<unknown>): RunToolResult {
  return { httpStatus: httpStatusForEnvelope(envelope), envelope };
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
 * 4. A mutating tool whose caller is an agent with `status !== 'active'` →
 *    403 `AGENT_NOT_ACTIVE`.
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
 * 7. Any other thrown error (from `getDb`, world/clock setup, auth, or the
 *    handler itself) → 500 `INTERNAL_ERROR`, logged server-side with
 *    `requestId` and never leaking its message/stack to the caller.
 *
 * Every returned/stored/replayed HTTP status is derived from its
 * envelope's `status` via `httpStatusForEnvelope` — never hard-coded.
 */
export async function runTool(
  tool: ToolDef | undefined,
  toolName: string,
  rawInput: unknown,
  { getDb, authorization = null, idempotencyKey = null, requestId = randomUUID() }: RunToolDeps,
): Promise<RunToolResult> {
  if (!tool) {
    return respond(fail("NOT_FOUND", `Unknown tool: ${toolName}`, [toolName]));
  }

  try {
    const db = await getDb();

    let agent: AgentPrincipal | null = null;
    let worldId: string;

    if (tool.auth === "agent") {
      if (!authorization) {
        return respond(fail("UNAUTHORIZED", "Missing API key.", ["missing_api_key"]));
      }

      const presentedKey = extractApiKey(authorization);
      agent = await verifyApiKey(db, presentedKey);
      if (!agent) {
        return respond(fail("UNAUTHORIZED", "Invalid API key.", ["invalid_api_key"]));
      }

      worldId = agent.worldId;
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
      return respond(fail("INVALID_REQUEST", "Invalid input.", reasonCodes));
    }

    if (tool.mutating && agent && agent.status !== "active") {
      return respond(fail("AGENT_NOT_ACTIVE", "This agent is not active.", ["agent_not_active"]));
    }

    const afterCommitCallbacks: Array<() => Promise<void> | void> = [];
    function afterCommit(fn: () => Promise<void> | void): void {
      afterCommitCallbacks.push(fn);
    }

    let envelope: Envelope<unknown>;

    if (tool.mutating) {
      if (agent && effectiveIdempotencyKey) {
        const agentId = agent.agentId;
        const requestHash = hashRequest(toolName, parsed.data);

        try {
          envelope = await db.transaction(async (tx) => {
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

            const result = await tool.handler(parsed.data, {
              worldId,
              simNow,
              agentId,
              agent,
              requestId,
              db,
              tx,
              scoped: scoped(tx, worldId),
              afterCommit,
            });

            await tx
              .update(idempotencyKeys)
              .set({ response: result, httpStatus: httpStatusForEnvelope(result) })
              .where(eq(idempotencyKeys.id, claimedId));

            return result;
          });
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
            );
          }

          if (existing.requestHash !== requestHash) {
            return respond(
              fail(
                "IDEMPOTENCY_CONFLICT",
                "This idempotency key was already used with different input.",
                ["idempotency_key_conflict"],
              ),
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
        envelope = await db.transaction((tx) =>
          tool.handler(parsed.data, {
            worldId,
            simNow,
            agentId: agent?.agentId ?? null,
            agent,
            requestId,
            db,
            tx,
            scoped: scoped(tx, worldId),
            afterCommit,
          }),
        );
      }
    } else {
      envelope = await tool.handler(parsed.data, {
        worldId,
        simNow,
        agentId: agent?.agentId ?? null,
        agent,
        requestId,
        db,
        tx: db,
        scoped: scoped(db, worldId),
        afterCommit,
      });
    }

    for (const callback of afterCommitCallbacks) {
      try {
        await callback();
      } catch (err) {
        console.error(`[runTool] ${toolName} afterCommit callback failed (requestId=${requestId}):`, err);
      }
    }

    return respond(envelope);
  } catch (err) {
    // The real error (which may include infra details, e.g. connection
    // strings or query text) is logged server-side only, keyed by
    // requestId. Callers/clients only ever see the generic message below.
    console.error(`[runTool] ${toolName} failed (requestId=${requestId}):`, err);

    return respond(
      fail(
        "INTERNAL_ERROR",
        `Something went wrong handling this request. (request_id: ${requestId})`,
        ["internal_error"],
        { request_id: requestId },
      ),
    );
  }
}
