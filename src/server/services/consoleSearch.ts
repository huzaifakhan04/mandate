import { inArray } from "drizzle-orm";

import type { Db } from "../db/client";
import { agents } from "../db/schema";
import { scoped } from "../db/scoped";
import { elasticErrorMessage } from "../elastic/client";
import { ELASTIC_DISABLED_NOTE, elasticConfigured } from "../elastic/config";
import { cleanQuery, keywordEvents, semanticApplications } from "../elastic/search";
import { type ConsoleWorld, scrubText, shortLabel } from "./console";

/**
 * P7 — the console's Risk Desk search (`GET /api/console/search`): hybrid
 * over ONE world (the same world the snapshot resolved) — semantic search
 * over application purposes (Jina embeddings + Jina reranker) and keyword
 * search over the events. Public like the snapshot, so it returns no PII:
 * agents by scrubbed name, applications by short label, the purpose as
 * shipped (already redacted), no principal or payer identities at all.
 * An Elastic network caller (never inside a transaction).
 */

export const SEARCH_MIN_CHARS = 2;

export interface ConsoleSearchResult {
  enabled: boolean;
  note: string | null;
  query: string;
  applications: Array<{
    label: string;
    agent: string;
    decision: string;
    amountCents: number;
    termDays: number;
    reasons: string[];
    purpose: string;
    simAt: string;
    score: number;
  }>;
  events: Array<{ type: string; agent: string; amountCents: number | null; reasons: string[]; simAt: string; score: number }>;
  error: string | null;
}

export async function consoleSearch(db: Db, world: ConsoleWorld, rawQuery: string): Promise<ConsoleSearchResult> {
  const query = cleanQuery(rawQuery);
  const empty: ConsoleSearchResult = { enabled: elasticConfigured(), note: null, query, applications: [], events: [], error: null };
  if (!elasticConfigured()) {
    return { ...empty, note: ELASTIC_DISABLED_NOTE };
  }
  if (query.length < SEARCH_MIN_CHARS) {
    return empty;
  }
  try {
    const [apps, evs] = await Promise.all([
      semanticApplications(world.id, query, { size: 6 }),
      keywordEvents(world.id, query, { size: 10 }),
    ]);
    const agentIds = [...new Set([...apps.map((a) => a.agent_id), ...evs.map((e) => e.agent_id)].filter((id): id is string => !!id))];
    const rows = agentIds.length
      ? await scoped(db, world.id).selectFields(agents, { id: agents.id, name: agents.name }, inArray(agents.id, agentIds))
      : [];
    const nameOf = new Map(rows.map((r) => [r.id, scrubText(r.name)]));
    return {
      ...empty,
      applications: apps.map((a) => ({
        label: shortLabel("A", a.application_id),
        agent: nameOf.get(a.agent_id) ?? "—",
        decision: a.decision,
        amountCents: a.amount_cents,
        termDays: a.term_days,
        reasons: a.reasons,
        purpose: scrubText(a.purpose),
        simAt: a.sim_at,
        score: Math.round(a.score * 1000) / 1000,
      })),
      events: evs.map((e) => ({
        type: e.type,
        agent: e.agent_id ? (nameOf.get(e.agent_id) ?? "—") : "—",
        amountCents: e.amount_cents,
        reasons: e.reasons,
        simAt: e.sim_at,
        score: Math.round(e.score * 1000) / 1000,
      })),
    };
  } catch (err) {
    console.error(`[console] search failed: ${elasticErrorMessage(err)}`);
    return { ...empty, error: "search_unavailable" };
  }
}
