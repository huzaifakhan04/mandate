import type { Db } from "../db/client";
import { recordRiskHit, type RiskHit, type RiskKind } from "../services/riskFlags";
import { elasticErrorMessage } from "./client";
import { asList, runEsqlTemplate } from "./esql";

/**
 * P7 Task 2 — the deterministic risk detectors. Each is an allowlisted
 * ES|QL template (`elastic/esql.ts`) over one world's shipped data, plus a
 * small deterministic post-step in TypeScript where ES|QL can't express
 * it (a sliding 10-minute window; a median that counts idle days).
 * Bots (the private worlds' simulated economy) are never flagged.
 *
 *   self_dealing   an invoice link paid by the borrower's own human (payer
 *                  hash = the borrower principal's verified payer hash), or
 *                  one payer hash paying for agents of ≥ 3 unrelated humans
 *   score_farming  ≥ 3 borrow→repay cycles each < 1 sim day (last 7 sim days)
 *   sybil_burst    ≥ 4 agents registered by one human within 10 real minutes
 *   probing        ≥ 3 declines, then a smaller application within 1 sim day
 *   velocity       redemption requests today ≥ 3 and > 3× the 7-day median
 *
 * Every hit becomes (at most) one `risk_flags` row per (agent, kind,
 * window) via `recordRiskHit`. Never inside a DB transaction.
 */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export const DETECTOR_LIMITS = {
  lookbackSimDays: 7,
  farmingMinCycles: 3,
  sharedPayerMinPrincipals: 3,
  sybilMinAgents: 4,
  sybilWindowMinutes: 10,
  sybilLookbackHours: 24,
  probingMinDeclines: 3,
  velocityMinRequests: 3,
  velocityMultiple: 3,
  velocityBaselineDays: 7,
} as const;

export interface DetectorContext {
  worldId: string;
  /** The world's sim time (sim-time detectors). */
  simNow: Date;
  /** Real time (the sybil and velocity detectors). */
  now: Date;
}

type Detector = (ctx: DetectorContext) => Promise<RiskHit[]>;

function iso(date: Date): string {
  return date.toISOString();
}

function toDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function strings(value: unknown): string[] {
  return asList(value).filter((v): v is string => typeof v === "string");
}

const latest = (a: Date | null, b: Date): Date => (a && a.getTime() > b.getTime() ? a : b);

/** Clamps evidence times to the world's sim time (real-time detectors use "now" in sim). */
function clampToSim(date: Date | null, simNow: Date): Date {
  return date && date.getTime() <= simNow.getTime() ? date : simNow;
}

export const detectSelfDealing: Detector = async ({ worldId, simNow }) => {
  const hits = new Map<string, RiskHit>();
  const same = await runEsqlTemplate("self_dealing_same_payer", { world_id: worldId });
  for (const row of same.rows) {
    const agentId = row.agent_id as string;
    hits.set(agentId, {
      agentId,
      kind: "self_dealing",
      evidenceSimAt: simNow,
      evidence: {
        pattern: "paid_by_own_human",
        orders: Number(row.orders ?? 0),
        loans: strings(row.loans).slice(0, 10),
        last_at: row.last_at ?? null,
        template: "self_dealing_same_payer",
      },
    });
  }
  const shared = await runEsqlTemplate("self_dealing_shared_payer", {
    world_id: worldId,
    min_principals: DETECTOR_LIMITS.sharedPayerMinPrincipals,
  });
  for (const row of shared.rows) {
    const agentIds = strings(row.agents);
    for (const agentId of agentIds) {
      if (hits.has(agentId)) continue;
      hits.set(agentId, {
        agentId,
        kind: "self_dealing",
        evidenceSimAt: simNow,
        evidence: {
          pattern: "shared_payer",
          payer_hash: row.payer_hash ?? null,
          unrelated_principals: Number(row.principals ?? 0),
          agents: agentIds.slice(0, 10),
          last_at: row.last_at ?? null,
          template: "self_dealing_shared_payer",
        },
      });
    }
  }
  return [...hits.values()];
};

export const detectScoreFarming: Detector = async ({ worldId, simNow }) => {
  const since = new Date(simNow.getTime() - DETECTOR_LIMITS.lookbackSimDays * DAY_MS);
  const result = await runEsqlTemplate("score_farming", {
    world_id: worldId,
    since: iso(since),
    min_cycles: DETECTOR_LIMITS.farmingMinCycles,
  });
  return result.rows.map((row) => ({
    agentId: row.agent_id as string,
    kind: "score_farming" as RiskKind,
    evidenceSimAt: clampToSim(toDate(row.last_at), simNow),
    evidence: {
      cycles_under_one_day: Number(row.cycles ?? 0),
      loans: strings(row.loans).slice(0, 10),
      last_repaid_sim_at: row.last_at ?? null,
      lookback_sim_days: DETECTOR_LIMITS.lookbackSimDays,
      template: "score_farming",
    },
  }));
};

/** Pure: the largest set of registrations inside any `windowMs` sliding window. */
export function densestWindow<T extends { at: Date }>(items: readonly T[], windowMs: number): T[] {
  const sorted = [...items].sort((a, b) => a.at.getTime() - b.at.getTime());
  let best: T[] = [];
  let start = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    while (sorted[end]!.at.getTime() - sorted[start]!.at.getTime() > windowMs) start += 1;
    if (end - start + 1 > best.length) best = sorted.slice(start, end + 1);
  }
  return best;
}

export const detectSybilBurst: Detector = async ({ worldId, simNow, now }) => {
  const since = new Date(now.getTime() - DETECTOR_LIMITS.sybilLookbackHours * 60 * MINUTE_MS);
  const candidates = await runEsqlTemplate("sybil_candidates", {
    world_id: worldId,
    since: iso(since),
    min_agents: DETECTOR_LIMITS.sybilMinAgents,
  });
  const hits: RiskHit[] = [];
  for (const candidate of candidates.rows) {
    const principalHash = candidate.principal_hash as string;
    const registrations = await runEsqlTemplate("sybil_registrations", {
      world_id: worldId,
      since: iso(since),
      principal_hash: principalHash,
    });
    const items = registrations.rows
      .map((r) => ({ agentId: r.agent_id as string, at: toDate(r.created_at), simAt: toDate(r.sim_at) }))
      .filter((r): r is { agentId: string; at: Date; simAt: Date | null } => typeof r.agentId === "string" && r.at !== null);
    const burst = densestWindow(items, DETECTOR_LIMITS.sybilWindowMinutes * MINUTE_MS);
    if (burst.length < DETECTOR_LIMITS.sybilMinAgents) continue;
    const spanMinutes = Math.round((burst[burst.length - 1]!.at.getTime() - burst[0]!.at.getTime()) / MINUTE_MS);
    const lastSim = burst.reduce<Date | null>((acc, r) => (r.simAt ? latest(acc, r.simAt) : acc), null);
    for (const reg of burst) {
      hits.push({
        agentId: reg.agentId,
        kind: "sybil_burst",
        evidenceSimAt: clampToSim(lastSim, simNow),
        evidence: {
          principal_hash: principalHash,
          agents_in_burst: burst.length,
          burst_span_minutes: spanMinutes,
          agents: burst.map((r) => r.agentId).slice(0, 10),
          first_registered_at: burst[0]!.at.toISOString(),
          template: "sybil_candidates+sybil_registrations",
        },
      });
    }
  }
  return hits;
};

interface AppRow {
  agentId: string;
  applicationId: string;
  decision: string;
  amountCents: number;
  simAt: Date;
}

/** Pure: per agent, the first application smaller than a decline it follows, with ≥ 3 declines in the prior sim day. */
export function probingHits(rows: readonly AppRow[]): Array<{ agentId: string; probe: AppRow; declines: AppRow[] }> {
  const byAgent = new Map<string, AppRow[]>();
  for (const row of rows) {
    byAgent.set(row.agentId, [...(byAgent.get(row.agentId) ?? []), row]);
  }
  const out: Array<{ agentId: string; probe: AppRow; declines: AppRow[] }> = [];
  for (const [agentId, apps] of byAgent) {
    const sorted = [...apps].sort((a, b) => a.simAt.getTime() - b.simAt.getTime());
    let found: { probe: AppRow; declines: AppRow[] } | null = null;
    for (let i = 0; i < sorted.length; i += 1) {
      const app = sorted[i]!;
      const prior = sorted
        .slice(0, i)
        .filter((p) => p.decision === "declined" && app.simAt.getTime() - p.simAt.getTime() <= DAY_MS);
      if (prior.length >= DETECTOR_LIMITS.probingMinDeclines && app.amountCents < prior[prior.length - 1]!.amountCents) {
        found = { probe: app, declines: prior };
      }
    }
    if (found) out.push({ agentId, ...found });
  }
  return out;
}

export const detectProbing: Detector = async ({ worldId, simNow }) => {
  const since = new Date(simNow.getTime() - DETECTOR_LIMITS.lookbackSimDays * DAY_MS);
  const result = await runEsqlTemplate("probing_applications", {
    world_id: worldId,
    since: iso(since),
    min_declines: DETECTOR_LIMITS.probingMinDeclines,
  });
  const rows: AppRow[] = result.rows
    .map((r) => ({
      agentId: r.agent_id as string,
      applicationId: r.application_id as string,
      decision: String(r.decision ?? ""),
      amountCents: Number(r.amount_cents ?? 0),
      simAt: toDate(r.sim_at)!,
    }))
    .filter((r) => typeof r.agentId === "string" && r.simAt !== null);
  return probingHits(rows).map(({ agentId, probe, declines }) => ({
    agentId,
    kind: "probing" as RiskKind,
    evidenceSimAt: clampToSim(probe.simAt, simNow),
    evidence: {
      declines_before: declines.length,
      declined_amounts_cents: declines.map((d) => d.amountCents).slice(-6),
      probe_amount_cents: probe.amountCents,
      probe_decision: probe.decision,
      probe_application_id: probe.applicationId,
      probe_sim_at: probe.simAt.toISOString(),
      template: "probing_applications",
    },
  }));
};

/** Pure: the median of a list of numbers (0 for an empty list). */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export const detectVelocity: Detector = async ({ worldId, simNow, now }) => {
  const today = Math.floor(now.getTime() / DAY_MS);
  const since = new Date((today - DETECTOR_LIMITS.velocityBaselineDays) * DAY_MS);
  const result = await runEsqlTemplate("velocity_daily", { world_id: worldId, since: iso(since) });
  const perAgent = new Map<string, Map<number, number>>();
  for (const row of result.rows) {
    const day = toDate(row.day);
    if (typeof row.agent_id !== "string" || !day) continue;
    const days = perAgent.get(row.agent_id) ?? new Map<number, number>();
    days.set(Math.floor(day.getTime() / DAY_MS), Number(row.requests ?? 0));
    perAgent.set(row.agent_id, days);
  }
  const hits: RiskHit[] = [];
  for (const [agentId, days] of perAgent) {
    const todayCount = days.get(today) ?? 0;
    const baseline = Array.from({ length: DETECTOR_LIMITS.velocityBaselineDays }, (_, i) => days.get(today - 1 - i) ?? 0);
    const med = median(baseline);
    if (todayCount >= DETECTOR_LIMITS.velocityMinRequests && todayCount > DETECTOR_LIMITS.velocityMultiple * med) {
      hits.push({
        agentId,
        kind: "velocity",
        evidenceSimAt: simNow,
        evidence: {
          requests_today: todayCount,
          median_prior_7_days: med,
          prior_7_days: baseline,
          template: "velocity_daily",
        },
      });
    }
  }
  return hits;
};

export const DETECTORS: Record<RiskKind, Detector> = {
  self_dealing: detectSelfDealing,
  score_farming: detectScoreFarming,
  sybil_burst: detectSybilBurst,
  probing: detectProbing,
  velocity: detectVelocity,
};

export interface DetectorReport {
  hits: Partial<Record<RiskKind, number>>;
  newFlagIds: string[];
  errors: string[];
}

/** Runs every detector for one world and records the hits. One detector failing doesn't stop the others. */
export async function runDetectors(db: Db, ctx: DetectorContext): Promise<DetectorReport> {
  const report: DetectorReport = { hits: {}, newFlagIds: [], errors: [] };
  for (const [kind, detector] of Object.entries(DETECTORS) as Array<[RiskKind, Detector]>) {
    let hits: RiskHit[];
    try {
      hits = await detector(ctx);
    } catch (err) {
      report.errors.push(`${kind}: ${elasticErrorMessage(err)}`);
      continue;
    }
    report.hits[kind] = hits.length;
    for (const hit of hits) {
      const flagId = await recordRiskHit(db, ctx.worldId, hit, ctx.simNow);
      if (flagId) report.newFlagIds.push(flagId);
    }
  }
  return report;
}
