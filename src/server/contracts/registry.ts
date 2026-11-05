import { z } from "zod";

import type { AgentPrincipal } from "../auth/apiKeys";
import type { Db } from "../db/client";
import type { scoped } from "../db/scoped";
import type { Envelope } from "./envelope";

/**
 * Per-request context handed to every tool handler.
 *
 * - `worldId`/`simNow` come from the main world's clock (Task 4), or from
 *   the authenticated agent's own world for `auth: 'agent'` tools.
 * - `agent` is the authenticated caller (`null` for `auth: 'none'` tools);
 *   `agentId` is a convenience alias for `agent?.agentId ?? null`.
 * - `db` is the plain database handle; `tx` is the per-call transaction for
 *   mutating tools, and equals `db` for `readOnly` tools (no transaction is
 *   opened). `scoped` is `scoped(tx, worldId)` — the world-scoped query
 *   helper, already wired to whichever of `db`/`tx` is in effect.
 * - `afterCommit` registers a callback to run, in registration order, after
 *   the per-call transaction commits (mutating tools) or right after the
 *   handler returns (readOnly tools, where there is no transaction). A
 *   callback that throws is logged and does not change the envelope. These
 *   do NOT run when an idempotent replay short-circuits the handler.
 * - `setFinalizeState` (Fix round 1, I2b) passes bookkeeping from `handler`
 *   to an optional `finalize` hook out-of-band — `handler`'s own returned
 *   envelope stays a clean, public, safely-replayable fallback (no smuggled
 *   internal fields), since `finalize` reads this state instead of
 *   `envelope.data`. Calling it more than once keeps only the last value;
 *   never calling it leaves `finalize`'s `state` argument `undefined`.
 * - `requestId` is a fresh id minted per request.
 */
export interface ToolCtx {
  worldId: string;
  simNow: Date;
  agentId: string | null;
  agent: AgentPrincipal | null;
  requestId: string;
  db: Db;
  tx: Db;
  scoped: ReturnType<typeof scoped>;
  afterCommit: (fn: () => Promise<void> | void) => void;
  setFinalizeState: (state: unknown) => void;
}

/**
 * Context handed to an optional `finalize` hook (Ruling K): everything a
 * post-commit step needs to execute a queued PayPal/sim operation and
 * build the real response, but none of the per-call transaction (the
 * commit already happened by the time `finalize` runs).
 */
export interface FinalizeCtx {
  worldId: string;
  simNow: Date;
  agentId: string | null;
  agent: AgentPrincipal | null;
  requestId: string;
  db: Db;
}

export interface ToolDef<
  Input extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
  Output extends z.ZodType = z.ZodType,
> {
  name: string;
  title: string;
  description: string;
  auth: "none" | "agent";
  mutating: boolean;
  /**
   * Whether this tool is safe to expose over `GET` and runs without a
   * per-call transaction (`ctx.tx === ctx.db`). Must be the exact opposite
   * of `mutating` — `defineTool` enforces this invariant so a tool can't
   * accidentally be both (or neither).
   */
  readOnly: boolean;
  /**
   * Ruling L (Fix round 1): whether a mutating, agent-scoped call under an
   * `Idempotency-Key` gets the claim-first store/replay protocol at all.
   * Defaults to `true`. A tool that is naturally idempotent by some other
   * key of its own (e.g. `confirm_checkout`, idempotent by `checkout_id`)
   * sets this `false` so `runTool` ignores any idempotency key entirely —
   * storing an in-progress status like `AWAITING_APPROVAL` under the key
   * would otherwise freeze a caller's polling loop on a stale snapshot.
   */
  idempotent?: boolean;
  input: Input;
  output: Output;
  handler: (input: z.infer<Input>, ctx: ToolCtx) => Promise<Envelope<unknown>>;
  /**
   * Ruling K: a tool whose response depends on a PayPal/sim result that
   * can only be produced after the per-call transaction commits (e.g.
   * `buy_notes` needs the `order.create` operation's approve URL, and
   * "never call PayPal inside a DB transaction" forbids getting that
   * inside `handler`). When present, `runTool` calls `finalize` with the
   * envelope `handler` returned (already committed), the `state`
   * `ctx.setFinalizeState` was called with (if at all — `undefined`
   * otherwise), after every `ctx.afterCommit` callback has run, and uses
   * whatever `finalize` returns as the call's real result. For a mutating,
   * agent-scoped call made under an idempotency key (and `idempotent !==
   * false`), the *finalized* envelope — not `handler`'s — is what gets
   * stored and replayed. Never runs on an idempotent replay (nothing new
   * happened). If `finalize` throws (Fix round 1, I2c), `runTool` logs it
   * and falls back to `handler`'s own (already-safe, already-replayable)
   * envelope rather than inventing a generic `INTERNAL_ERROR`, and leaves
   * any stored idempotency row untouched.
   */
  finalize?: (envelope: Envelope<unknown>, ctx: FinalizeCtx, state: unknown) => Promise<Envelope<unknown>>;
}

/**
 * The contract registry. Order is registration order: tools are added by
 * importing their defining module (see `src/server/contracts/tools/index.ts`),
 * and every consumer (REST, MCP, OpenAPI, tests) imports that module first so
 * the registry is populated before it is read.
 */
export const registry: ToolDef[] = [];

/**
 * Registers a tool definition and returns it unchanged.
 *
 * Enforces the one invariant `runTool`'s REST `GET` dispatch relies on:
 * `readOnly` must be the exact opposite of `mutating`, so a tool can't
 * accidentally be both (or neither).
 *
 * A `mutating` tool is NOT required to have `auth: 'agent'` — e.g. Task 4's
 * `register_agent` is `auth: 'none'` and mutating (it creates the very
 * agent that would authenticate later calls). `runTool` handles this: a
 * mutating tool with no authenticated agent still runs inside a
 * transaction, but idempotency is skipped entirely for it — there is no
 * agent to attribute an `idempotency_keys` row to, and that column is
 * `NOT NULL`.
 */
export function defineTool<
  Input extends z.ZodObject<z.ZodRawShape>,
  Output extends z.ZodType,
>(def: ToolDef<Input, Output>): ToolDef<Input, Output> {
  if (def.readOnly === def.mutating) {
    throw new Error(
      `Tool "${def.name}": readOnly must be the opposite of mutating.`,
    );
  }
  registry.push(def as unknown as ToolDef);
  return def;
}

/** Looks up a tool by name, or `undefined` if no such tool is registered. */
export function findTool(name: string): ToolDef | undefined {
  return registry.find((tool) => tool.name === name);
}

/** JSON Schema for the envelope shape, reused across every OpenAPI response. */
const envelopeJsonSchema = {
  type: "object",
  required: ["status", "summary", "reason_codes", "data", "next_actions", "docs_url"],
  properties: {
    status: { type: "string" },
    summary: { type: "string" },
    reason_codes: { type: "array", items: { type: "string" } },
    data: { type: "object" },
    next_actions: {
      type: "array",
      items: {
        type: "object",
        required: ["tool", "args"],
        properties: {
          tool: { type: "string" },
          args: { type: "object" },
        },
      },
    },
    docs_url: { type: "string" },
  },
} as const;

/**
 * Builds the OpenAPI 3.1 document for the registry: one `POST /api/v1/{name}`
 * path per registered tool. Request bodies come from `z.toJSONSchema(input)`;
 * every response uses the shared envelope schema.
 */
export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};

  for (const tool of registry) {
    paths[`/api/v1/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.title,
        description: tool.description,
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: z.toJSONSchema(tool.input) },
          },
        },
        responses: {
          "200": {
            description: "Envelope response",
            content: { "application/json": { schema: envelopeJsonSchema } },
          },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: { title: "Mandate Bank API", version: "1.0.0" },
    paths,
  };
}
