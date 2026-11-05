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
import { fail } from "./envelope";
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

/** Strips an optional `Bearer ` prefix from an `Authorization` header value. */
function extractApiKey(authorization: string): string {
  const trimmed = authorization.trim();
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(trimmed);
  return bearerMatch ? bearerMatch[1]!.trim() : trimmed;
}

/** Deterministically stringifies a value with object keys sorted, so the
 * same logical input always hashes the same way regardless of key order. */
function stableStringify(value: unknown): string {
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
 *    main world.
 * 3. The input is validated against the tool's Zod schema (after stripping
 *    an `idempotency_key` arg, if present) → 400 `INVALID_REQUEST`.
 * 4. Mutating tools only: idempotency-key handling (replay/conflict/fresh)
 *    and the handler runs inside a `db.transaction`.
 * 5. After the transaction commits (or, for `readOnly` tools, right after
 *    the handler returns), every `ctx.afterCommit` callback registered
 *    during the call runs in order; a callback that throws is logged and
 *    does not change the envelope. Callbacks do not run on an idempotent
 *    replay.
 * 6. Any other thrown error (from `getDb`, world/clock setup, auth, or the
 *    handler itself) → 500 `INTERNAL_ERROR`, logged server-side with
 *    `requestId` and never leaking its message/stack to the caller.
 */
export async function runTool(
  tool: ToolDef | undefined,
  toolName: string,
  rawInput: unknown,
  { getDb, authorization = null, idempotencyKey = null, requestId = randomUUID() }: RunToolDeps,
): Promise<RunToolResult> {
  if (!tool) {
    return {
      httpStatus: 404,
      envelope: fail("NOT_FOUND", `Unknown tool: ${toolName}`, [toolName]),
    };
  }

  try {
    const db = await getDb();

    let agent: AgentPrincipal | null = null;
    let worldId: string;

    if (tool.auth === "agent") {
      if (!authorization) {
        return {
          httpStatus: 401,
          envelope: fail("UNAUTHORIZED", "Missing API key.", ["missing_api_key"]),
        };
      }

      const presentedKey = extractApiKey(authorization);
      agent = await verifyApiKey(db, presentedKey);
      if (!agent) {
        return {
          httpStatus: 401,
          envelope: fail("UNAUTHORIZED", "Invalid API key.", ["invalid_api_key"]),
        };
      }

      worldId = agent.worldId;
    } else {
      const mainWorld = await ensureMainWorldOnce(db);
      worldId = mainWorld.worldId;
    }

    const simNow = await getSimNow(db, worldId);

    const { input: strippedInput, key: bodyIdempotencyKey } = extractIdempotencyKeyArg(rawInput);
    const effectiveIdempotencyKey = idempotencyKey ?? bodyIdempotencyKey;

    const parsed = tool.input.safeParse(strippedInput);
    if (!parsed.success) {
      const reasonCodes = parsed.error.issues.flatMap((issue) => {
        if (issue.code === "unrecognized_keys") {
          return issue.keys.map((key) => `unrecognized_key:${key}`);
        }
        return [issue.path.join(".") || "root"];
      });
      return {
        httpStatus: 400,
        envelope: fail("INVALID_REQUEST", "Invalid input.", reasonCodes),
      };
    }

    const afterCommitCallbacks: Array<() => Promise<void> | void> = [];
    function afterCommit(fn: () => Promise<void> | void): void {
      afterCommitCallbacks.push(fn);
    }

    let envelope: Envelope<unknown>;

    if (tool.mutating) {
      // Invariant enforced by `defineTool`: a mutating tool requires
      // `auth: 'agent'`, so `agent` is always set here.
      const agentId = agent!.agentId;
      const requestHash = effectiveIdempotencyKey
        ? hashRequest(toolName, parsed.data)
        : null;

      if (effectiveIdempotencyKey) {
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

        if (existing) {
          if (existing.requestHash === requestHash) {
            // Replay: return the stored envelope/status verbatim, and do
            // NOT run afterCommit callbacks (nothing new happened).
            return {
              httpStatus: existing.httpStatus,
              envelope: existing.response as Envelope<unknown>,
            };
          }

          return {
            httpStatus: 409,
            envelope: fail(
              "IDEMPOTENCY_CONFLICT",
              "This idempotency key was already used with different input.",
              ["idempotency_key_conflict"],
            ),
          };
        }
      }

      envelope = await db.transaction(async (tx) => {
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

        if (effectiveIdempotencyKey) {
          await tx.insert(idempotencyKeys).values({
            worldId,
            agentId,
            key: effectiveIdempotencyKey,
            requestHash: requestHash!,
            response: result,
            httpStatus: 200,
          });
        }

        return result;
      });
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

    return { httpStatus: 200, envelope };
  } catch (err) {
    // The real error (which may include infra details, e.g. connection
    // strings or query text) is logged server-side only, keyed by
    // requestId. Callers/clients only ever see the generic message below.
    console.error(`[runTool] ${toolName} failed (requestId=${requestId}):`, err);

    return {
      httpStatus: 500,
      envelope: fail(
        "INTERNAL_ERROR",
        `Something went wrong handling this request. (request_id: ${requestId})`,
        ["internal_error"],
        { request_id: requestId },
      ),
    };
  }
}
