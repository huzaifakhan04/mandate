import { elasticClient } from "./client";
import { ELASTIC_INDICES } from "./config";

/**
 * P7: the allowlisted ES|QL query templates. Nothing else is ever sent to
 * `POST /_query`: the detectors run the `detector` templates, and the risk
 * investigator's `esql` tool may run only the `investigator` ones, by id.
 * Every template is scoped to one world by `?world_id`, which the caller
 * (never the model) supplies; other parameters are validated per template
 * (uuids, ISO timestamps, small integers) before anything is sent.
 */

export type EsqlParam = string | number | boolean;
export type ParamKind = "world" | "uuid" | "iso" | "int" | "hash";

export interface EsqlTemplate {
  id: string;
  use: "detector" | "investigator";
  description: string;
  params: Record<string, ParamKind>;
  query: string;
}

const EV = ELASTIC_INDICES.events;
const OPS = ELASTIC_INDICES.paypalOps;
const APPS = ELASTIC_INDICES.applications;

/** Not a bot (an unresolved agent has `is_bot` null and is skipped by the detectors). */
const HUMAN = "is_bot == false";

export const ESQL_TEMPLATES: Record<string, EsqlTemplate> = {
  // ------------------------------------------------------------ detectors
  self_dealing_same_payer: {
    id: "self_dealing_same_payer",
    use: "detector",
    description: "Invoice links paid by the borrower's own human (payer hash = the borrower principal's payer hash).",
    params: { world_id: "world" },
    query: `FROM ${OPS}
| WHERE world_id == ?world_id AND ${HUMAN} AND agent_id IS NOT NULL AND payer_hash IS NOT NULL AND borrower_payer_hash IS NOT NULL
| WHERE payer_hash == borrower_payer_hash
| STATS orders = COUNT_DISTINCT(op_id), loans = VALUES(loan_id), last_at = MAX(updated_at) BY agent_id
| SORT agent_id
| LIMIT 200`,
  },
  self_dealing_shared_payer: {
    id: "self_dealing_shared_payer",
    use: "detector",
    description: "One payer (hash) approving invoice links for agents of several unrelated principals.",
    params: { world_id: "world", min_principals: "int" },
    query: `FROM ${OPS}
| WHERE world_id == ?world_id AND ${HUMAN} AND agent_id IS NOT NULL AND payer_hash IS NOT NULL AND borrower_principal_hash IS NOT NULL
| WHERE borrower_payer_hash IS NULL OR payer_hash != borrower_payer_hash
| STATS principals = COUNT_DISTINCT(borrower_principal_hash), agents = VALUES(agent_id), last_at = MAX(updated_at) BY payer_hash
| WHERE principals >= ?min_principals
| SORT payer_hash
| LIMIT 100`,
  },
  score_farming: {
    id: "score_farming",
    use: "detector",
    description: "Borrow→repay cycles shorter than one sim day, per agent.",
    params: { world_id: "world", since: "iso", min_cycles: "int" },
    query: `FROM ${EV}
| WHERE world_id == ?world_id AND stream == "event" AND type IN ("loan.disbursed", "loan.repaid") AND agent_id IS NOT NULL AND ${HUMAN}
| WHERE sim_at >= TO_DATETIME(?since)
| STATS disbursed_at = MIN(sim_at) WHERE type == "loan.disbursed", repaid_at = MAX(sim_at) WHERE type == "loan.repaid" BY aggregate_id, agent_id
| WHERE disbursed_at IS NOT NULL AND repaid_at IS NOT NULL
| EVAL cycle_minutes = DATE_DIFF("minute", disbursed_at, repaid_at)
| WHERE cycle_minutes < 1440
| STATS cycles = COUNT(*), loans = VALUES(aggregate_id), last_at = MAX(repaid_at) BY agent_id
| WHERE cycles >= ?min_cycles
| SORT agent_id
| LIMIT 200`,
  },
  sybil_candidates: {
    id: "sybil_candidates",
    use: "detector",
    description: "Principals (hashed) with several human-registered agents recently.",
    params: { world_id: "world", since: "iso", min_agents: "int" },
    query: `FROM ${EV}
| WHERE world_id == ?world_id AND type == "agent.registered" AND principal_hash IS NOT NULL AND ${HUMAN}
| WHERE created_at >= TO_DATETIME(?since)
| STATS agents = COUNT(*) BY principal_hash
| WHERE agents >= ?min_agents
| SORT principal_hash
| LIMIT 100`,
  },
  sybil_registrations: {
    id: "sybil_registrations",
    use: "detector",
    description: "One principal's (hashed) registrations, oldest first.",
    params: { world_id: "world", since: "iso", principal_hash: "hash" },
    query: `FROM ${EV}
| WHERE world_id == ?world_id AND type == "agent.registered" AND principal_hash == ?principal_hash AND ${HUMAN}
| WHERE created_at >= TO_DATETIME(?since)
| KEEP agent_id, created_at, sim_at
| SORT created_at, agent_id
| LIMIT 500`,
  },
  probing_applications: {
    id: "probing_applications",
    use: "detector",
    description: "Applications of agents with at least three declines in the window, in sim-time order.",
    params: { world_id: "world", since: "iso", min_declines: "int" },
    query: `FROM ${APPS}
| WHERE world_id == ?world_id AND ${HUMAN} AND sim_at >= TO_DATETIME(?since)
| INLINE STATS declines = COUNT(*) WHERE decision == "declined" BY agent_id
| WHERE declines >= ?min_declines
| KEEP agent_id, application_id, decision, amount_cents, sim_at
| SORT agent_id, sim_at, application_id
| LIMIT 5000`,
  },
  velocity_daily: {
    id: "velocity_daily",
    use: "detector",
    description: "Note redemption requests per agent per real day.",
    params: { world_id: "world", since: "iso" },
    query: `FROM ${EV}
| WHERE world_id == ?world_id AND type == "note.redemption_requested" AND agent_id IS NOT NULL AND ${HUMAN}
| WHERE created_at >= TO_DATETIME(?since)
| EVAL day = DATE_TRUNC(1 day, created_at)
| STATS requests = COUNT(*), amount_cents = SUM(amount_cents) BY agent_id, day
| SORT agent_id, day
| LIMIT 5000`,
  },

  // --------------------------------------------------------- investigator
  agent_timeline: {
    id: "agent_timeline",
    use: "investigator",
    description: "The agent's latest 40 bank events (type, sim time, amount, reasons).",
    params: { world_id: "world", agent_id: "uuid" },
    query: `FROM ${EV}
| WHERE world_id == ?world_id AND agent_id == ?agent_id
| SORT sim_at DESC
| KEEP type, sim_at, amount_cents, reasons, grade, score
| LIMIT 40`,
  },
  agent_applications: {
    id: "agent_applications",
    use: "investigator",
    description: "The agent's latest 25 loan applications (decision, amount, term, reasons, stated purpose).",
    params: { world_id: "world", agent_id: "uuid" },
    query: `FROM ${APPS}
| WHERE world_id == ?world_id AND agent_id == ?agent_id
| SORT sim_at DESC
| KEEP sim_at, decision, amount_cents, term_days, reasons, has_invoice, purpose_text
| LIMIT 25`,
  },
  agent_loan_cycles: {
    id: "agent_loan_cycles",
    use: "investigator",
    description: "Per loan of the agent: disbursed and repaid sim times and the cycle length in hours.",
    params: { world_id: "world", agent_id: "uuid" },
    query: `FROM ${EV}
| WHERE world_id == ?world_id AND agent_id == ?agent_id AND type IN ("loan.disbursed", "loan.repaid")
| STATS disbursed_at = MIN(sim_at) WHERE type == "loan.disbursed", repaid_at = MAX(sim_at) WHERE type == "loan.repaid" BY aggregate_id
| EVAL cycle_hours = DATE_DIFF("hour", disbursed_at, repaid_at)
| SORT disbursed_at DESC
| KEEP disbursed_at, repaid_at, cycle_hours
| LIMIT 25`,
  },
  agent_invoice_payers: {
    id: "agent_invoice_payers",
    use: "investigator",
    description: "The agent's PayPal operations with a payer: whether the payer is the borrower's own human, and how many agents that payer paid for.",
    params: { world_id: "world", agent_id: "uuid" },
    query: `FROM ${OPS}
| WHERE world_id == ?world_id AND agent_id == ?agent_id AND payer_hash IS NOT NULL
| EVAL paid_by_own_human = COALESCE(payer_hash == borrower_payer_hash, false)
| STATS ops = COUNT(*), own_human = MAX(CASE(paid_by_own_human, 1, 0)), last_at = MAX(updated_at) BY kind, purpose, status
| LIMIT 25`,
  },
  agent_redemptions_daily: {
    id: "agent_redemptions_daily",
    use: "investigator",
    description: "The agent's note redemption requests per real day over the last 30 days.",
    params: { world_id: "world", agent_id: "uuid" },
    query: `FROM ${EV}
| WHERE world_id == ?world_id AND agent_id == ?agent_id AND type == "note.redemption_requested"
| EVAL day = DATE_TRUNC(1 day, created_at)
| STATS requests = COUNT(*), amount_cents = SUM(amount_cents) BY day
| SORT day DESC
| LIMIT 30`,
  },
  world_baseline: {
    id: "world_baseline",
    use: "investigator",
    description: "The world's baseline for comparison: applications, decline rate and average amount by decision.",
    params: { world_id: "world" },
    query: `FROM ${APPS}
| WHERE world_id == ?world_id
| STATS applications = COUNT(*), avg_amount_cents = AVG(amount_cents), agents = COUNT_DISTINCT(agent_id) BY decision
| LIMIT 10`,
  },
};

export const INVESTIGATOR_TEMPLATE_IDS = Object.values(ESQL_TEMPLATES)
  .filter((t) => t.use === "investigator")
  .map((t) => t.id);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const HASH_RE = /^h_[0-9a-f]{24}$/;

export class EsqlParamError extends Error {}

/** Validates `params` against the template (every declared param present and well-formed; no extras). */
export function validateParams(template: EsqlTemplate, params: Record<string, unknown>): Record<string, EsqlParam> {
  const out: Record<string, EsqlParam> = {};
  for (const key of Object.keys(params)) {
    if (!(key in template.params)) {
      throw new EsqlParamError(`unknown parameter ${key} for ${template.id}`);
    }
  }
  for (const [key, kind] of Object.entries(template.params)) {
    const value = params[key];
    const ok =
      kind === "world" || kind === "uuid"
        ? typeof value === "string" && UUID_RE.test(value)
        : kind === "iso"
          ? typeof value === "string" && ISO_RE.test(value)
          : kind === "hash"
            ? typeof value === "string" && HASH_RE.test(value)
            : typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000;
    if (!ok) {
      throw new EsqlParamError(`invalid parameter ${key} for ${template.id}`);
    }
    out[key] = value as EsqlParam;
  }
  return out;
}

export interface EsqlResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

/** Runs an allowlisted template by id. Throws when Elastic isn't configured or the call fails. */
export async function runEsqlTemplate(
  templateId: string,
  params: Record<string, unknown>,
  { signal }: { signal?: AbortSignal } = {},
): Promise<EsqlResult> {
  const template = ESQL_TEMPLATES[templateId];
  if (!template) {
    throw new EsqlParamError(`unknown ES|QL template ${templateId}`);
  }
  const values = validateParams(template, params);
  const client = elasticClient();
  if (!client) {
    throw new Error("Elastic is not configured");
  }
  const response = await client.esql.query(
    {
      query: template.query,
      params: Object.entries(values).map(([name, value]) => ({ [name]: value })) as never,
    },
    signal ? { signal } : {},
  );
  const columns = (response.columns ?? []).map((c) => c.name);
  const rows = (response.values ?? []).map((row) =>
    Object.fromEntries(columns.map((name, i) => [name, (row as unknown[])[i] ?? null])),
  );
  return { columns, rows };
}

/** An ES|QL multi-value cell as a list (a single value comes back as a scalar). */
export function asList(value: unknown): unknown[] {
  if (value === null || value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
