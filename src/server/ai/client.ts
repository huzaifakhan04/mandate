import OpenAI from "openai";

import type { AiRole } from "./schemas";

/**
 * OpenAI configuration for the AI roles. One attempt per call (the SDK's
 * retries are off) bounded by `AI_TIMEOUT_MS`; on any failure `runRole`
 * falls back to the template, so a retry would only delay the response.
 */

export const AI_TIMEOUT_MS = 20_000;

let timeoutMs = AI_TIMEOUT_MS;

/** Test hook: shortens the per-call timeout. */
export function __setAiTimeoutMsForTests(ms: number): void {
  timeoutMs = ms;
}

export function __resetAiTimeoutMsForTests(): void {
  timeoutMs = AI_TIMEOUT_MS;
}

export function aiTimeoutMs(): number {
  return timeoutMs;
}

/** `OPENAI_DISABLED=1` or a missing `OPENAI_API_KEY` forces templates. */
export function aiDisabled(): boolean {
  return process.env.OPENAI_DISABLED === "1" || !process.env.OPENAI_API_KEY;
}

/** KYA desk → `OPENAI_MODEL_CHECK`; loan and risk officers → `OPENAI_MODEL_UNDERWRITER`. */
export function modelFor(role: AiRole): string | null {
  const id = role === "kya_desk" ? process.env.OPENAI_MODEL_CHECK : process.env.OPENAI_MODEL_UNDERWRITER;
  return id?.trim() || null;
}

let client: OpenAI | null = null;
let clientKey: string | null = null;

/** A lazily created client (re-created if the key changes, e.g. between tests). */
export function openaiClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!client || clientKey !== apiKey) {
    client = new OpenAI({ apiKey, maxRetries: 0, timeout: AI_TIMEOUT_MS });
    clientKey = apiKey;
  }
  return client;
}
