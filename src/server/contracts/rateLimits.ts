import { DAY_MS, HOUR_MS, type DbLimit } from "../http/dbRateLimit";
import type { RateLimitCtx } from "./registry";

/**
 * P8: the tool rate limits (Postgres-backed, fixed windows — see
 * `src/server/http/dbRateLimit.ts`). One table so `/agents.md` documents
 * exactly what `runTool` enforces.
 */
export const TOOL_RATE_LIMITS = {
  register_agent: { perIpPerHour: 10, perIpAndNamePerHour: 3 },
  apply_for_loan: { perAgentPerSimDay: 30, perAgentPerHour: 60 },
  buy_notes: { perAgentPerHour: 30 },
  repay_loan: { perAgentPerHour: 30 },
} as const;

/** `register_agent`: per IP 10/hour and per IP + name 3/hour (skipped when the IP is unknown, e.g. internal calls). */
export function registerAgentLimits({ clientIp, input }: RateLimitCtx<{ name: string }>): DbLimit[] {
  if (!clientIp) {
    return [];
  }
  const name = input.name.trim().toLowerCase();
  return [
    { key: `register:ip:${clientIp}`, limit: TOOL_RATE_LIMITS.register_agent.perIpPerHour, windowMs: HOUR_MS },
    {
      key: `register:ip_name:${clientIp}:${name}`,
      limit: TOOL_RATE_LIMITS.register_agent.perIpAndNamePerHour,
      windowMs: HOUR_MS,
    },
  ];
}

/** `apply_for_loan`: per agent 30 per simulated day (on the world's clock) and 60 per real hour. */
export function applyForLoanLimits({ agentId, simNow }: RateLimitCtx): DbLimit[] {
  if (!agentId) {
    return [];
  }
  return [
    {
      key: `apply:simday:${agentId}`,
      limit: TOOL_RATE_LIMITS.apply_for_loan.perAgentPerSimDay,
      windowMs: DAY_MS,
      now: simNow,
    },
    { key: `apply:hour:${agentId}`, limit: TOOL_RATE_LIMITS.apply_for_loan.perAgentPerHour, windowMs: HOUR_MS },
  ];
}

/** `buy_notes` / `repay_loan` checkout creation: per agent 30 per real hour (each makes a PayPal order). */
export function checkoutLimits(tool: "buy_notes" | "repay_loan") {
  return ({ agentId }: RateLimitCtx): DbLimit[] =>
    agentId ? [{ key: `checkout:${tool}:${agentId}`, limit: TOOL_RATE_LIMITS[tool].perAgentPerHour, windowMs: HOUR_MS }] : [];
}
