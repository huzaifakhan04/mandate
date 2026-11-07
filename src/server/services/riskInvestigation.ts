import { eq } from "drizzle-orm";

import {
  type InvestigatorOutput,
  type InvestigatorToolCall,
  type InvestigatorTools,
  runInvestigator,
} from "../ai/investigator";
import { redact } from "../ai/redact";
import { cleanText } from "../ai/sanitize";
import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { agents, applications, loans, notePositions, riskFlags, worlds } from "../db/schema";
import { scoped } from "../db/scoped";
import { elasticErrorMessage } from "../elastic/client";
import { elasticConfigured } from "../elastic/config";
import { INVESTIGATOR_TEMPLATE_IDS, runEsqlTemplate } from "../elastic/esql";
import { semanticApplications } from "../elastic/search";
import { loadAgentKya } from "./kya";
import {
  claimFlagForInvestigation,
  flagsAwaitingInvestigation,
  RISK_KIND_TEXT,
  type RiskFlagRow,
  type RiskKind,
  storeCaseFile,
} from "./riskFlags";

/**
 * P7 Task 3 — the risk investigator's case files: an AFTER-COMMIT module
 * (listed in `AI_CALLERS` and in the Elastic callers,
 * tests/unit/ai/noTransactionCalls.test.ts and
 * tests/unit/elastic/noTransactionCalls.test.ts). It takes a plain `db`,
 * is called by the tick after the detectors committed their flags, and
 * never opens a transaction.
 *
 * For each new flag (claimed with a conditional update so two ticks never
 * investigate the same flag) it binds the three tools to the flag's world
 * and agent — `esql` (allowlisted investigator templates only),
 * `semantic_search` (Jina embeddings + Jina reranker over application
 * purposes) and `agent_profile` (a scrubbed DB read) — and runs the
 * bounded tool-calling loop (`ai/investigator.ts`). Agents appear to the
 * model only as aliases (`agent_1` is the flagged agent).
 *
 * The deterministic template — the same tools, called in a fixed order,
 * summarized by rule — is the case file whenever the model is unavailable
 * or invalid, and always in a private world (no model call there). If
 * Elastic itself is down, the template still writes a case file from the
 * database profile alone. The case file is advisory: it never changes
 * the flag's status.
 */

export const INVESTIGATIONS_PER_WORLD_PER_TICK = 2;
/** The whole investigation (every model and tool call) must finish within this. */
export const INVESTIGATION_DEADLINE_MS = 45_000;

/** Which investigator template best tests each detector's hypothesis (used by the template). */
const KIND_TEMPLATE: Record<RiskKind, string> = {
  self_dealing: "agent_invoice_payers",
  score_farming: "agent_loan_cycles",
  sybil_burst: "agent_timeline",
  probing: "agent_applications",
  velocity: "agent_redemptions_daily",
};

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export interface StoredCaseFile extends InvestigatorOutput {
  source: "ai" | "template" | "fallback";
  steps: number;
  tool_calls: InvestigatorToolCall[];
  generated_at: string;
}

/** Aliases for the flagged agent (`agent_1`) and the agents its evidence names. */
export class AgentAliases {
  private readonly byId = new Map<string, string>();
  private readonly byAlias = new Map<string, string>();

  constructor(primary: string, related: readonly string[]) {
    for (const id of [primary, ...related]) {
      const key = id.toLowerCase();
      if (!this.byId.has(key)) {
        const alias = `agent_${this.byId.size + 1}`;
        this.byId.set(key, alias);
        this.byAlias.set(alias, key);
      }
    }
  }

  idOf(alias: string): string | null {
    return this.byAlias.get(alias.trim().toLowerCase()) ?? null;
  }

  aliases(): string[] {
    return [...this.byAlias.keys()];
  }

  /** Replaces known agent ids with their alias; any other uuid becomes `other`. */
  apply<T>(value: T): T {
    const text = JSON.stringify(value ?? null).replace(UUID_RE, (id) => this.byId.get(id.toLowerCase()) ?? "other");
    return JSON.parse(text) as T;
  }
}

function relatedAgents(evidence: unknown): string[] {
  const list = (evidence as { agents?: unknown } | null)?.agents;
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
}

/** The scrubbed profile `agent_profile` returns (no names of humans, no payout receiver, no emails). */
export async function agentProfile(db: Db, worldId: string, agentId: string, now: Date = new Date()): Promise<Record<string, unknown> | null> {
  const world = scoped(db, worldId);
  const agent = await world.findOne(agents, eq(agents.id, agentId));
  if (!agent) {
    return null;
  }
  const { tier } = await loadAgentKya(db, worldId, agentId, now);
  const loanRows = await world.selectFields(loans, { status: loans.status, principalCents: loans.principalCents }, eq(loans.agentId, agentId));
  const appRows = await world.selectFields(applications, { decision: applications.decision }, eq(applications.agentId, agentId));
  const positions = await world.selectFields(notePositions, { units: notePositions.units }, eq(notePositions.agentId, agentId));
  const flags = await world.selectFields(riskFlags, { kind: riskFlags.kind, status: riskFlags.status }, eq(riskFlags.agentId, agentId));
  const loansByStatus: Record<string, number> = {};
  for (const l of loanRows) loansByStatus[l.status] = (loansByStatus[l.status] ?? 0) + 1;
  return {
    agent_id: agent.id,
    name: cleanText(redact(agent.name), 60),
    operator: cleanText(redact(agent.operator), 60),
    status: agent.status,
    kya_tier: tier.tier,
    is_bot: agent.isBot,
    claimed: agent.claimedAt !== null,
    registered_sim_at: agent.registeredSimAt?.toISOString() ?? null,
    loans: { total: loanRows.length, by_status: loansByStatus, principal_cents: loanRows.reduce((s, l) => s + Number(l.principalCents), 0) },
    applications: { total: appRows.length, declined: appRows.filter((a) => a.decision === "declined").length },
    note_positions: positions.length,
    risk_flags: flags.map((f) => ({ kind: f.kind, status: f.status })),
  };
}

/** The three tools, bound to one world and one flag's aliases. */
export function boundTools(db: Db, worldId: string, aliases: AgentAliases, { signal, now }: { signal?: AbortSignal; now: Date }): InvestigatorTools {
  return {
    async esql(templateId, agentRef) {
      if (!INVESTIGATOR_TEMPLATE_IDS.includes(templateId)) {
        return { error: `template ${templateId} is not allowlisted; use one of ${INVESTIGATOR_TEMPLATE_IDS.join(", ")}` };
      }
      const agentId = aliases.idOf(agentRef);
      const needsAgent = templateId !== "world_baseline";
      if (needsAgent && !agentId) {
        return { error: `unknown agent_ref ${agentRef}; known: ${aliases.aliases().join(", ")}` };
      }
      const result = await runEsqlTemplate(
        templateId,
        needsAgent ? { world_id: worldId, agent_id: agentId } : { world_id: worldId },
        signal ? { signal } : {},
      );
      return aliases.apply({ template_id: templateId, rows: result.rows.slice(0, 25) });
    },
    async semanticSearch(query) {
      const hits = await semanticApplications(worldId, query, { size: 5, ...(signal ? { signal } : {}) });
      return aliases.apply({ query: cleanText(query, 200), hits: hits.map((hit) => ({ ...hit, application_id: undefined })) });
    },
    async agentProfile(agentRef) {
      const agentId = aliases.idOf(agentRef);
      if (!agentId) {
        return { error: `unknown agent_ref ${agentRef}; known: ${aliases.aliases().join(", ")}` };
      }
      return aliases.apply(await agentProfile(db, worldId, agentId, now));
    },
  };
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

/** The deterministic case file: fixed tool calls, rule-based summary. */
export async function templateInvestigation(
  flag: Pick<RiskFlagRow, "kind" | "evidence">,
  tools: InvestigatorTools,
  { elastic }: { elastic: boolean },
): Promise<{ output: InvestigatorOutput; toolCalls: InvestigatorToolCall[] }> {
  const kind = flag.kind as RiskKind;
  const toolCalls: InvestigatorToolCall[] = [];
  const evidence: string[] = [];
  const profile = (await tools.agentProfile("agent_1").catch(() => null)) as Record<string, unknown> | null;
  toolCalls.push({ tool: "agent_profile", ok: profile !== null });
  if (profile) {
    const loansInfo = profile.loans as { total?: number } | undefined;
    const appsInfo = profile.applications as { total?: number; declined?: number } | undefined;
    evidence.push(
      `Profile: tier T${String(profile.kya_tier ?? "?")}, ${loansInfo?.total ?? 0} loans, ` +
        `${appsInfo?.total ?? 0} applications (${appsInfo?.declined ?? 0} declined).`,
    );
  }
  const ev = (flag.evidence ?? {}) as Record<string, unknown>;
  switch (kind) {
    case "self_dealing":
      evidence.push(
        ev.pattern === "paid_by_own_human"
          ? `${String(ev.orders ?? "?")} invoice payment(s) came from the borrower's own human's PayPal account.`
          : `One payer paid invoice links for agents of ${String(ev.unrelated_principals ?? "?")} unrelated humans.`,
      );
      break;
    case "score_farming":
      evidence.push(`${String(ev.cycles_under_one_day ?? "?")} borrow-and-repay cycles shorter than one sim day in the last 7 sim days.`);
      break;
    case "sybil_burst":
      evidence.push(`${String(ev.agents_in_burst ?? "?")} agents registered by one human within ${String(ev.burst_span_minutes ?? "?")} minutes.`);
      break;
    case "probing":
      evidence.push(
        `${String(ev.declines_before ?? "?")} declines, then a smaller application of ${String(ev.probe_amount_cents ?? "?")} cents within one sim day.`,
      );
      break;
    case "velocity":
      evidence.push(`${String(ev.requests_today ?? "?")} redemption requests today vs a 7-day median of ${String(ev.median_prior_7_days ?? "?")}.`);
      break;
  }
  if (elastic) {
    const templateId = KIND_TEMPLATE[kind];
    try {
      const rows = rowsOf(await tools.esql(templateId, "agent_1"));
      toolCalls.push({ tool: "esql", template_id: templateId, ok: true });
      evidence.push(`ES|QL ${templateId}: ${rows.length} row(s) for the agent.`);
    } catch {
      toolCalls.push({ tool: "esql", template_id: templateId, ok: false });
    }
    if (kind === "probing" || kind === "sybil_burst") {
      try {
        const apps = rowsOf(await tools.esql("agent_applications", "agent_1"));
        const purpose = apps.map((r) => r.purpose_text).find((p): p is string => typeof p === "string" && p.length > 0);
        if (purpose) {
          const result = (await tools.semanticSearch(purpose)) as { hits?: Array<{ agent_id?: string }> };
          toolCalls.push({ tool: "semantic_search", ok: true });
          const others = new Set((result.hits ?? []).map((h) => h.agent_id).filter((a) => a && a !== "agent_1"));
          evidence.push(`Semantic search on its latest purpose: ${others.size} other agent(s) state a similar purpose.`);
        }
      } catch {
        toolCalls.push({ tool: "semantic_search", ok: false });
      }
    }
  }
  const recommendation: InvestigatorOutput["recommendation"] =
    kind === "self_dealing" && ev.pattern === "paid_by_own_human" ? "escalate" : kind === "sybil_burst" ? "escalate" : "keep";
  return {
    output: {
      summary:
        `Automated check of a ${kind.replace(/_/g, " ")} flag: ${RISK_KIND_TEXT[kind]} ` +
        `Borrowing stays limited to T0 while the flag is open; an owner can request review and an admin decides.`,
      evidence: evidence.slice(0, 6).map((e) => cleanText(e, 300)),
      recommendation,
    },
    toolCalls,
  };
}

export interface InvestigationOutcome {
  flagId: string;
  investigated: boolean;
  source?: StoredCaseFile["source"];
  recommendation?: InvestigatorOutput["recommendation"];
  error?: string;
}

/**
 * Investigates one flag (if it can claim it) and stores the case file.
 * `forceModel` lets the ops smoke script exercise the model loop in a
 * private world; nothing in the app sets it.
 */
export async function investigateFlag(
  db: Db,
  worldId: string,
  flagId: string,
  { now = new Date(), signal, forceModel = false }: { now?: Date; signal?: AbortSignal; forceModel?: boolean } = {},
): Promise<InvestigationOutcome> {
  if (!(await claimFlagForInvestigation(db, worldId, flagId, now))) {
    return { flagId, investigated: false };
  }
  const flag = await scoped(db, worldId).findOne(riskFlags, eq(riskFlags.id, flagId));
  if (!flag) {
    return { flagId, investigated: false };
  }
  const [world] = await db.select({ kind: worlds.kind }).from(worlds).where(eq(worlds.id, worldId)).limit(1);
  const aliases = new AgentAliases(flag.agentId, relatedAgents(flag.evidence));
  const deadline = AbortSignal.timeout(INVESTIGATION_DEADLINE_MS);
  const bound = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const tools = boundTools(db, worldId, aliases, { signal: bound, now });
  const elastic = elasticConfigured();

  let template: { output: InvestigatorOutput; toolCalls: InvestigatorToolCall[] };
  try {
    template = await templateInvestigation(flag, tools, { elastic });
  } catch (err) {
    template = {
      output: {
        summary: `Automated check of a ${flag.kind.replace(/_/g, " ")} flag could not gather evidence; a human should review it.`,
        evidence: [],
        recommendation: "keep",
      },
      toolCalls: [],
    };
    console.error(`[risk] template investigation failed: ${elasticErrorMessage(err)}`);
  }

  let caseFile: StoredCaseFile;
  let aiRunId: string | null = null;
  // P8: the demo world, like a private one, never spends on an LLM.
  if ((world?.kind === "private" || world?.kind === "demo") && !forceModel) {
    caseFile = { ...template.output, source: "template", steps: 0, tool_calls: template.toolCalls, generated_at: now.toISOString() };
  } else {
    const simNow = await getSimNow(db, worldId, now);
    const input = aliases.apply({
      flag: {
        kind: flag.kind,
        detector: RISK_KIND_TEXT[flag.kind as RiskKind] ?? flag.kind,
        evidence: flag.evidence,
        first_sim_at: flag.firstSimAt.toISOString(),
        last_evidence_sim_at: flag.lastEvidenceSimAt.toISOString(),
      },
      subject: "agent_1",
      related_agents: aliases.aliases().filter((a) => a !== "agent_1"),
      sim_now: simNow.toISOString(),
      elastic_available: elastic,
      esql_templates: INVESTIGATOR_TEMPLATE_IDS,
    });
    const run = await runInvestigator(db, worldId, input, tools, INVESTIGATOR_TEMPLATE_IDS, {
      template: template.output,
      subject: `risk_flag:${flag.id}`,
      signal: bound,
    });
    aiRunId = run.aiRunId;
    caseFile = {
      ...run.output,
      source: run.fallbackUsed ? "fallback" : "ai",
      steps: run.steps,
      tool_calls: run.fallbackUsed ? [...run.toolCalls, ...template.toolCalls] : run.toolCalls,
      generated_at: now.toISOString(),
    };
  }
  await storeCaseFile(db, worldId, flag.id, caseFile as unknown as Record<string, unknown>, aiRunId);
  return { flagId, investigated: true, source: caseFile.source, recommendation: caseFile.recommendation };
}

/** The tick's step: investigate up to `limit` new flags of the world, each time-bounded. */
export async function investigatePendingFlags(
  db: Db,
  worldId: string,
  { now = new Date(), limit = INVESTIGATIONS_PER_WORLD_PER_TICK, signal }: { now?: Date; limit?: number; signal?: AbortSignal } = {},
): Promise<InvestigationOutcome[]> {
  const out: InvestigationOutcome[] = [];
  for (const flag of await flagsAwaitingInvestigation(db, worldId, now, limit)) {
    if (signal?.aborted) break;
    try {
      out.push(await investigateFlag(db, worldId, flag.id, { now, ...(signal ? { signal } : {}) }));
    } catch (err) {
      out.push({ flagId: flag.id, investigated: false, error: elasticErrorMessage(err) });
    }
  }
  return out;
}
