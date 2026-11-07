import { createHash } from "crypto";

import { APIConnectionTimeoutError, APIError } from "openai";
import { z } from "zod";

import type { Db } from "@/server/db/client";
import { aiRuns } from "@/server/db/schema";
import { scoped } from "@/server/db/scoped";

import { aiDisabled, aiTimeoutMs, modelFor, openaiClient } from "./client";
import { RISK_INVESTIGATOR_PROMPT } from "./prompts/risk_investigator";
import { redact } from "./redact";
import type { AiErrorCode } from "./run";
import { cleanList, cleanText } from "./sanitize";

/**
 * P7 Task 3 — the risk investigator: a bounded multi-step tool-calling
 * loop on the OpenAI Responses API (function tools), at most
 * `MAX_INVESTIGATOR_STEPS` model calls, then a structured case file
 * `{summary, evidence[], recommendation}`.
 *
 * RULE (like `runRole`): never inside a DB transaction — it is called by
 * `services/riskInvestigation.ts`, an after-commit module listed in
 * `AI_CALLERS`. The tools themselves are injected by that caller, already
 * bound to one world and one flag: the model only ever sees aliases
 * ("agent_1"), redacted values and allowlisted ES|QL template ids.
 *
 * Advisory only: the recommendation changes nothing. Any failure —
 * disabled, timeout, HTTP error, no final answer within the step budget,
 * invalid JSON, schema or policy violation — returns the caller's
 * deterministic template instead. Every call writes one `ai_runs` row
 * (role `risk_investigator`).
 */

export const MAX_INVESTIGATOR_STEPS = 6;
export const MAX_TOOL_CALLS = 8;
/** Per model call; the whole loop is also bounded by the caller's signal. */
export const INVESTIGATOR_MAX_OUTPUT_TOKENS = 1500;
const TOOL_OUTPUT_MAX_CHARS = 6000;

export const RECOMMENDATIONS = ["clear", "keep", "escalate"] as const;

export const investigatorOutputSchema = z.strictObject({
  summary: z.string().min(1).max(1200),
  evidence: z.array(z.string().min(1).max(400)).max(8),
  recommendation: z.enum(RECOMMENDATIONS),
});
export type InvestigatorOutput = z.infer<typeof investigatorOutputSchema>;

export const INVESTIGATOR_OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    recommendation: { type: "string", enum: [...RECOMMENDATIONS] },
  },
  required: ["summary", "evidence", "recommendation"],
  additionalProperties: false,
} as const;

/** The tools, bound by the caller to one world and one flag. Each returns JSON-safe data (already aliased). */
export interface InvestigatorTools {
  esql(templateId: string, agentRef: string): Promise<unknown>;
  semanticSearch(query: string): Promise<unknown>;
  agentProfile(agentRef: string): Promise<unknown>;
}

export interface InvestigatorToolCall {
  tool: "esql" | "semantic_search" | "agent_profile";
  template_id?: string;
  ok: boolean;
}

export function investigatorToolDefs(templateIds: readonly string[]) {
  return [
    {
      type: "function" as const,
      name: "esql",
      description: "Run one allowlisted ES|QL query template over this world's Risk Desk indices.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          template_id: { type: "string", enum: [...templateIds] },
          params: {
            type: "object",
            properties: { agent_ref: { type: "string", description: 'The agent alias, e.g. "agent_1".' } },
            required: ["agent_ref"],
            additionalProperties: false,
          },
        },
        required: ["template_id", "params"],
        additionalProperties: false,
      },
    },
    {
      type: "function" as const,
      name: "semantic_search",
      description: "Semantic search (Jina embeddings, Jina reranker) over this world's loan application purposes.",
      strict: true,
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      type: "function" as const,
      name: "agent_profile",
      description: "An agent's scrubbed bank profile (tier, status, loans, applications, flags).",
      strict: true,
      parameters: {
        type: "object",
        properties: { agent_ref: { type: "string" } },
        required: ["agent_ref"],
        additionalProperties: false,
      },
    },
  ];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function investigatorPromptHash(): string {
  return sha256(`${RISK_INVESTIGATOR_PROMPT}\n${JSON.stringify(INVESTIGATOR_OUTPUT_JSON_SCHEMA)}`);
}

const ACTION_CLAIM_RE = /\b(?:has been|was|were|have been|i have|i've|we have|we've)\s+(?:cleared|closed|escalated|lifted|removed|resolved)\b/i;

/** Sanitizes a schema-valid output; `null` when it breaks policy (claims an action was taken). */
export function sanitizeInvestigatorOutput(output: InvestigatorOutput): InvestigatorOutput | null {
  const text = [output.summary, ...output.evidence].join("\n");
  if (ACTION_CLAIM_RE.test(text)) {
    return null;
  }
  return {
    summary: cleanText(redact(output.summary), 600),
    evidence: cleanList(redact(output.evidence), 300).slice(0, 6),
    recommendation: output.recommendation,
  };
}

export interface InvestigatorResult {
  output: InvestigatorOutput;
  fallbackUsed: boolean;
  errorCode: AiErrorCode | null;
  aiRunId: string;
  steps: number;
  toolCalls: InvestigatorToolCall[];
}

interface FunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

async function dispatch(tools: InvestigatorTools, call: FunctionCallItem): Promise<{ result: unknown; record: InvestigatorToolCall }> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments) as Record<string, unknown>;
  } catch {
    return { result: { error: "invalid arguments" }, record: { tool: "esql", ok: false } };
  }
  try {
    switch (call.name) {
      case "esql": {
        const templateId = String(args.template_id ?? "");
        const agentRef = String((args.params as Record<string, unknown> | undefined)?.agent_ref ?? "agent_1");
        return { result: await tools.esql(templateId, agentRef), record: { tool: "esql", template_id: templateId, ok: true } };
      }
      case "semantic_search":
        return { result: await tools.semanticSearch(String(args.query ?? "")), record: { tool: "semantic_search", ok: true } };
      case "agent_profile":
        return { result: await tools.agentProfile(String(args.agent_ref ?? "agent_1")), record: { tool: "agent_profile", ok: true } };
      default:
        return { result: { error: `unknown tool ${call.name}` }, record: { tool: "esql", ok: false } };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0]!.slice(0, 200) : "tool failed";
    const tool = (["esql", "semantic_search", "agent_profile"] as const).find((t) => t === call.name) ?? "esql";
    return { result: { error: message }, record: { tool, ok: false } };
  }
}

export interface RunInvestigatorOptions {
  /** The deterministic case file used on any failure (built by the caller from the same tools). */
  template: InvestigatorOutput;
  subject: string;
  signal?: AbortSignal;
  maxSteps?: number;
}

/**
 * The tool-calling loop. `input` is the flag (kind, aliased evidence,
 * dates) — redacted again here before it is sent.
 */
export async function runInvestigator(
  db: Db,
  worldId: string,
  input: Record<string, unknown>,
  tools: InvestigatorTools,
  templateIds: readonly string[],
  options: RunInvestigatorOptions,
): Promise<InvestigatorResult> {
  const model = modelFor("risk_officer");
  const redactedInput = redact(input);
  const started = Date.now();
  const maxSteps = Math.min(options.maxSteps ?? MAX_INVESTIGATOR_STEPS, MAX_INVESTIGATOR_STEPS);
  const toolCalls: InvestigatorToolCall[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let steps = 0;
  let errorCode: AiErrorCode | null = null;
  let parsed: InvestigatorOutput | null = null;

  if (aiDisabled() || !model) {
    errorCode = "disabled";
  } else {
    const conversation: unknown[] = [{ role: "user", content: JSON.stringify(redactedInput) }];
    const toolDefs = investigatorToolDefs(templateIds);
    try {
      while (steps < maxSteps) {
        steps += 1;
        const last = steps === maxSteps || toolCalls.length >= MAX_TOOL_CALLS;
        const timeout = AbortSignal.timeout(aiTimeoutMs());
        const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
        let response;
        try {
          response = await openaiClient().responses.create(
            {
              model,
              instructions: RISK_INVESTIGATOR_PROMPT,
              input: conversation as never,
              tools: toolDefs,
              tool_choice: last ? "none" : "auto",
              store: false,
              include: ["reasoning.encrypted_content"],
              max_output_tokens: INVESTIGATOR_MAX_OUTPUT_TOKENS,
              text: { format: { type: "json_schema", name: "risk_case_file", schema: INVESTIGATOR_OUTPUT_JSON_SCHEMA, strict: true } },
            },
            { signal, maxRetries: 0 },
          );
        } catch (error) {
          if (timeout.aborted || error instanceof APIConnectionTimeoutError) {
            errorCode = "timeout";
          } else if (options.signal?.aborted) {
            errorCode = "aborted";
          } else if (error instanceof APIError && typeof error.status === "number") {
            errorCode = `http_${error.status}`;
          } else {
            errorCode = "request_failed";
          }
          break;
        }
        tokensIn += response.usage?.input_tokens ?? 0;
        tokensOut += response.usage?.output_tokens ?? 0;
        const calls = (response.output as unknown as Array<{ type: string }>).filter(
          (item): item is FunctionCallItem => item.type === "function_call",
        );
        if (calls.length > 0 && !last) {
          conversation.push(...(response.output as unknown[]));
          for (const call of calls) {
            const { result, record } =
              toolCalls.length < MAX_TOOL_CALLS
                ? await dispatch(tools, call)
                : { result: { error: "tool budget spent; answer now" }, record: null };
            if (record) toolCalls.push(record);
            const text = JSON.stringify(redact(result) ?? null);
            conversation.push({
              type: "function_call_output",
              call_id: call.call_id,
              output: text.length > TOOL_OUTPUT_MAX_CHARS ? `${text.slice(0, TOOL_OUTPUT_MAX_CHARS)}…` : text,
            });
          }
          continue;
        }
        if (response.status && response.status !== "completed") {
          errorCode = "incomplete";
          break;
        }
        let json: unknown;
        try {
          json = JSON.parse(response.output_text);
        } catch {
          errorCode = "invalid_json";
          break;
        }
        const valid = investigatorOutputSchema.safeParse(json);
        if (!valid.success) {
          errorCode = "schema_violation";
          break;
        }
        parsed = sanitizeInvestigatorOutput(valid.data);
        if (!parsed) {
          errorCode = "policy_violation";
        }
        break;
      }
      if (!parsed && errorCode === null) {
        errorCode = "incomplete";
      }
    } catch {
      errorCode = errorCode ?? "request_failed";
    }
  }

  const output = parsed ?? options.template;
  const fallbackUsed = parsed === null;
  const [row] = await scoped(db, worldId).insert(aiRuns, {
    role: "risk_investigator",
    model: model ?? "unset",
    promptHash: investigatorPromptHash(),
    inputHash: sha256(JSON.stringify(redactedInput)),
    subject: options.subject,
    output: { ...output, steps, tool_calls: toolCalls },
    latencyMs: Date.now() - started,
    tokensIn: tokensIn || null,
    tokensOut: tokensOut || null,
    fallbackUsed,
    errorCode,
  });
  return { output, fallbackUsed, errorCode, aiRunId: row!.id, steps, toolCalls };
}
