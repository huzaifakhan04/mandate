import { createHash } from "crypto";

import { APIConnectionTimeoutError, APIError } from "openai";

import type { Db } from "@/server/db/client";
import { aiRuns } from "@/server/db/schema";
import { scoped } from "@/server/db/scoped";

import { aiDisabled, aiTimeoutMs, modelFor, openaiClient } from "./client";
import { loanOfficerPolicyViolation } from "./policy";
import { KYA_DESK_PROMPT } from "./prompts/kya_desk";
import { LOAN_OFFICER_PROMPT } from "./prompts/loan_officer";
import { RISK_OFFICER_PROMPT } from "./prompts/risk_officer";
import { TREASURY_OFFICER_PROMPT } from "./prompts/treasury_officer";
import { redact } from "./redact";
import { type AiRole, INPUT_SCHEMAS, OUTPUT_JSON_SCHEMAS, OUTPUT_SCHEMAS, type RoleIO } from "./schemas";
import { TEMPLATES } from "./templates";

/**
 * `runRole` — the single entry point to the LLM (P3 Task 3).
 *
 * RULE: never call it inside a DB transaction (`db.transaction`, a tool
 * `handler`, anything holding a `ctx.tx`). It makes a network call of up
 * to 20 s. Call it from a tool's `finalize` hook, a `ctx.afterCommit`
 * callback or a route's `after()`. tests/unit/ai/noTransactionCalls.test.ts
 * enforces this statically.
 *
 * Decisions stay deterministic: the role gets an allowlisted, redacted
 * input describing a decision already made and only writes text. Any
 * failure — disabled, timeout, HTTP error, invalid JSON, schema or policy
 * violation — returns the deterministic template instead. Every call
 * writes one `ai_runs` row.
 */

export const PROMPTS: Record<AiRole, string> = {
  kya_desk: KYA_DESK_PROMPT,
  loan_officer: LOAN_OFFICER_PROMPT,
  risk_officer: RISK_OFFICER_PROMPT,
  treasury_officer: TREASURY_OFFICER_PROMPT,
};

export type AiErrorCode =
  | "disabled"
  | "timeout"
  | "aborted"
  | `http_${number}`
  | "request_failed"
  | "incomplete"
  | "invalid_json"
  | "schema_violation"
  | "policy_violation"
  | "rate_capped";

/** P3 final review I4: the most output tokens any role may produce (its JSON is a few hundred tokens). */
export const MAX_OUTPUT_TOKENS = 600;

export interface RunRoleOptions {
  /** Aborts the call early (e.g. the request's own deadline); falls back like a timeout. */
  signal?: AbortSignal;
  /** What the run is about (application id / document id), stored as `ai_runs.subject`. */
  subject?: string;
  /**
   * Skip the model and use the template, recording this as the run's
   * `error_code` (e.g. `rate_capped` once an agent's daily LLM budget is
   * spent). The `ai_runs` row is still written.
   */
  skipModel?: "rate_capped";
}

export interface RunRoleResult<R extends AiRole> {
  output: RoleIO[R]["output"];
  fallbackUsed: boolean;
  errorCode: AiErrorCode | null;
  aiRunId: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function promptHash(role: AiRole): string {
  return sha256(`${PROMPTS[role]}\n${JSON.stringify(OUTPUT_JSON_SCHEMAS[role])}`);
}

interface LlmAttempt {
  output: unknown;
  errorCode: AiErrorCode | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

async function callModel(
  role: AiRole,
  model: string,
  redactedInput: unknown,
  callerSignal: AbortSignal | undefined,
): Promise<LlmAttempt> {
  const timeout = AbortSignal.timeout(aiTimeoutMs());
  const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  try {
    const response = await openaiClient().responses.create(
      {
        model,
        instructions: PROMPTS[role],
        input: JSON.stringify(redactedInput),
        store: false,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        text: { format: { type: "json_schema", name: role, schema: OUTPUT_JSON_SCHEMAS[role], strict: true } },
      },
      { signal, maxRetries: 0 },
    );
    tokensIn = response.usage?.input_tokens ?? null;
    tokensOut = response.usage?.output_tokens ?? null;
    if (response.status && response.status !== "completed") {
      return { output: null, errorCode: "incomplete", tokensIn, tokensOut };
    }
    try {
      return { output: JSON.parse(response.output_text), errorCode: null, tokensIn, tokensOut };
    } catch {
      return { output: null, errorCode: "invalid_json", tokensIn, tokensOut };
    }
  } catch (error) {
    let errorCode: AiErrorCode;
    if (timeout.aborted || error instanceof APIConnectionTimeoutError) {
      errorCode = "timeout";
    } else if (callerSignal?.aborted) {
      errorCode = "aborted";
    } else if (error instanceof APIError && typeof error.status === "number") {
      errorCode = `http_${error.status}`;
    } else if (error instanceof SyntaxError) {
      errorCode = "invalid_json";
    } else {
      errorCode = "request_failed";
    }
    return { output: null, errorCode, tokensIn, tokensOut };
  }
}

export async function runRole<R extends AiRole>(
  db: Db,
  worldId: string,
  role: R,
  rawInput: RoleIO[R]["input"],
  options: RunRoleOptions = {},
): Promise<RunRoleResult<R>> {
  // The allowlist: zod strips every field the role's input schema doesn't name.
  const input = INPUT_SCHEMAS[role].parse(rawInput) as RoleIO[R]["input"];
  const redactedInput = redact(input);
  const template = (TEMPLATES[role] as (i: RoleIO[R]["input"]) => RoleIO[R]["output"])(input);
  const model = modelFor(role);

  const started = Date.now();
  let attempt: LlmAttempt;
  if (aiDisabled() || !model) {
    attempt = { output: null, errorCode: "disabled", tokensIn: null, tokensOut: null };
  } else if (options.skipModel) {
    attempt = { output: null, errorCode: options.skipModel, tokensIn: null, tokensOut: null };
  } else {
    attempt = await callModel(role, model, redactedInput, options.signal);
  }
  const latencyMs = Date.now() - started;

  let output: RoleIO[R]["output"] = template;
  let errorCode = attempt.errorCode;
  if (errorCode === null) {
    const parsed = OUTPUT_SCHEMAS[role].safeParse(attempt.output);
    if (!parsed.success) {
      errorCode = "schema_violation";
    } else if (
      role === "loan_officer" &&
      loanOfficerPolicyViolation(input as RoleIO["loan_officer"]["input"], parsed.data as RoleIO["loan_officer"]["output"])
    ) {
      errorCode = "policy_violation";
    } else {
      output = parsed.data as RoleIO[R]["output"];
    }
  }
  const fallbackUsed = errorCode !== null;

  const [row] = await scoped(db, worldId).insert(aiRuns, {
    role,
    model: model ?? "unset",
    promptHash: promptHash(role),
    inputHash: sha256(JSON.stringify(redactedInput)),
    subject: options.subject ?? null,
    output,
    latencyMs,
    tokensIn: attempt.tokensIn,
    tokensOut: attempt.tokensOut,
    fallbackUsed,
    errorCode,
  });

  return { output, fallbackUsed, errorCode, aiRunId: row!.id };
}
