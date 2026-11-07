import { redactText } from "../ai/redact";
import { cleanText } from "../ai/sanitize";
import { isReasonCode } from "../domain/reasons";
import { hashId } from "./config";

/**
 * P7: pure builders for the documents the outbox ships to Elasticsearch.
 * Each takes only the fields it needs and returns a JSON document with NO
 * PII: no emails, PayPal payer ids, payout receivers, API keys, principal
 * ids or raw PayPal bodies. Identities that the detectors must compare
 * (a principal, a PayPal payer) travel as keyed hashes (`hashId`); free
 * text (an application's purpose) is redacted (emails, keys, uuids, payer
 * ids → placeholders), stripped of links and capped.
 */

export interface AgentInfo {
  principalHash: string | null;
  isBot: boolean;
}

/** Free text an agent controls, made safe to ship. */
export function scrubFreeText(text: string, max = 500): string {
  return cleanText(redactText(text), max);
}

const GRADES = new Set(["A", "B", "C", "D", "E"]);

/** The few payload fields an event doc may carry: reason codes, a score/grade, amounts. Nothing else. */
export function safeEventFields(payload: unknown): {
  reasons: string[];
  grade: string | null;
  score: number | null;
  amount_cents: number | null;
} {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const reasons = Array.isArray(record.reasons) ? record.reasons.filter((r): r is string => typeof r === "string" && isReasonCode(r)) : [];
  const grade = typeof record.grade === "string" && GRADES.has(record.grade) ? record.grade : null;
  const score = typeof record.score === "number" && Number.isFinite(record.score) ? Math.round(record.score) : null;
  let amount: number | null = null;
  for (const [key, value] of Object.entries(record)) {
    if (key.endsWith("_cents") && typeof value === "number" && Number.isFinite(value)) {
      amount = Math.round(value);
      break;
    }
    if (key.endsWith("_cents") && typeof value === "string" && /^-?\d{1,15}$/.test(value)) {
      amount = Number(value);
      break;
    }
  }
  return { reasons, grade, score, amount_cents: amount };
}

export interface EventDocInput {
  id: string;
  worldId: string;
  seq: bigint;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  occurredSimAt: Date;
  createdAt: Date;
  agentId: string | null;
  agent: AgentInfo | null;
}

export function eventDoc(input: EventDocInput): Record<string, unknown> {
  const safe = safeEventFields(input.payload);
  return {
    doc_id: input.id,
    world_id: input.worldId,
    stream: "event",
    type: input.type,
    aggregate_type: input.aggregateType,
    aggregate_id: input.aggregateId,
    agent_id: input.agentId,
    principal_hash: input.agent?.principalHash ?? null,
    is_bot: input.agent?.isBot ?? null,
    amount_cents: safe.amount_cents,
    reasons: safe.reasons,
    grade: safe.grade,
    score: safe.score,
    seq: Number(input.seq),
    sim_at: input.occurredSimAt.toISOString(),
    created_at: input.createdAt.toISOString(),
    text: [input.type, input.aggregateType, ...safe.reasons, safe.grade ? `grade ${safe.grade}` : null]
      .filter(Boolean)
      .join(" "),
  };
}

export function agentRegisteredDoc(input: {
  id: string;
  worldId: string;
  principalId: string | null;
  isBot: boolean;
  simAt: Date;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    doc_id: `agent:${input.id}`,
    world_id: input.worldId,
    stream: "agent",
    type: "agent.registered",
    aggregate_type: "agent",
    aggregate_id: input.id,
    agent_id: input.id,
    principal_hash: hashId(input.principalId),
    is_bot: input.isBot,
    amount_cents: null,
    reasons: [],
    grade: null,
    score: null,
    seq: null,
    sim_at: input.simAt.toISOString(),
    created_at: input.createdAt.toISOString(),
    text: `agent.registered agent${input.isBot ? " bot" : ""}`,
  };
}

export function noteRedemptionDoc(input: {
  id: string;
  worldId: string;
  agentId: string | null;
  agent: AgentInfo | null;
  amountCents: bigint;
  status: string;
  simAt: Date;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    doc_id: `note_tx:${input.id}`,
    world_id: input.worldId,
    stream: "note_redemption",
    type: "note.redemption_requested",
    aggregate_type: "note_transaction",
    aggregate_id: input.id,
    agent_id: input.agentId,
    principal_hash: input.agent?.principalHash ?? null,
    is_bot: input.agent?.isBot ?? null,
    amount_cents: Number(input.amountCents),
    reasons: [],
    grade: null,
    score: null,
    seq: null,
    sim_at: input.simAt.toISOString(),
    created_at: input.createdAt.toISOString(),
    text: `note.redemption_requested ${input.status}`,
  };
}

export interface ApplicationDocInput {
  id: string;
  worldId: string;
  agentId: string;
  agent: AgentInfo | null;
  amountCents: bigint;
  termDays: number;
  purpose: string;
  hasInvoice: boolean;
  status: string;
  decision: string | null;
  reasonCodes: string[] | null;
  adverseAction: unknown;
  simAt: Date;
  createdAt: Date;
}

export function applicationDoc(input: ApplicationDocInput): Record<string, unknown> {
  const purpose = scrubFreeText(input.purpose) || "(no purpose given)";
  const adverse = input.adverseAction && typeof input.adverseAction === "object" ? (input.adverseAction as Record<string, unknown>) : {};
  return {
    application_id: input.id,
    world_id: input.worldId,
    agent_id: input.agentId,
    principal_hash: input.agent?.principalHash ?? null,
    is_bot: input.agent?.isBot ?? null,
    amount_cents: Number(input.amountCents),
    term_days: input.termDays,
    purpose,
    purpose_text: purpose,
    decision: input.decision ?? (input.status === "offered" ? "offered" : input.status),
    status: input.status,
    reasons: (input.reasonCodes ?? []).filter(isReasonCode),
    has_invoice: input.hasInvoice,
    grade: typeof adverse.grade === "string" && GRADES.has(adverse.grade) ? adverse.grade : null,
    score: typeof adverse.score === "number" ? Math.round(adverse.score) : null,
    sim_at: input.simAt.toISOString(),
    created_at: input.createdAt.toISOString(),
  };
}

export interface PaypalOpDocInput {
  id: string;
  worldId: string;
  kind: string;
  purpose: string | null;
  status: string;
  rail: string;
  httpStatus: number | null;
  attempts: number;
  latencyMs: number | null;
  amountCents: number | null;
  loanId: string | null;
  agentId: string | null;
  agent: AgentInfo | null;
  borrowerPayerId: string | null;
  /** The raw payer id read from the operation (hashed here, never shipped). */
  payerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function paypalOpDoc(input: PaypalOpDocInput): Record<string, unknown> {
  return {
    op_id: input.id,
    world_id: input.worldId,
    kind: input.kind,
    purpose: input.purpose,
    status: input.status,
    rail: input.rail,
    http_status: input.httpStatus,
    attempts: input.attempts,
    latency_ms: input.latencyMs,
    amount_cents: input.amountCents,
    loan_id: input.loanId,
    agent_id: input.agentId,
    is_bot: input.agent?.isBot ?? null,
    borrower_principal_hash: input.agent?.principalHash ?? null,
    borrower_payer_hash: hashId(input.borrowerPayerId),
    payer_hash: hashId(input.payerId),
    created_at: input.createdAt.toISOString(),
    updated_at: input.updatedAt.toISOString(),
  };
}

/** The payer id an operation shows: `order.get`'s parsed `payer`, or a sim order's approver. Never shipped raw. */
export function payerIdOf(response: unknown, simState: unknown): string | null {
  const fromResponse = (response as { payer?: { payerId?: unknown } } | null)?.payer?.payerId;
  if (typeof fromResponse === "string" && fromResponse.length > 0) {
    return fromResponse;
  }
  const fromSim = (simState as { payer?: { payerId?: unknown } } | null)?.payer?.payerId;
  return typeof fromSim === "string" && fromSim.length > 0 ? fromSim : null;
}
