import { elasticClient } from "./client";
import { ELASTIC_INDICES, JINA_RERANKER_ID } from "./config";
import { redactText } from "../ai/redact";

/**
 * P7: search over the Risk Desk indices, always confined to one world.
 *
 * - `semanticApplications`: Jina v5 embeddings (`semantic_text` on
 *   `mandate-applications.purpose`) retrieve the closest applications,
 *   then `.jina-reranker-v3` reranks them against the query text
 *   (`text_similarity_reranker` retriever) — the investigator's
 *   `semantic_search` tool and half of the console search.
 * - `keywordEvents`: a plain `match` over the events' scrubbed `text` and
 *   exact `type` — the other half of the console search.
 *
 * Only fields that are already PII-free in the index are returned.
 */

export const MAX_QUERY_CHARS = 200;

export interface ApplicationHit {
  application_id: string;
  agent_id: string;
  decision: string;
  amount_cents: number;
  term_days: number;
  reasons: string[];
  purpose: string;
  sim_at: string;
  score: number;
}

export interface EventHit {
  type: string;
  agent_id: string | null;
  amount_cents: number | null;
  reasons: string[];
  sim_at: string;
  score: number;
}

/**
 * A user/model query made safe and short: emails, keys, uuids and payer
 * ids redacted, whitespace collapsed, capped. (Dotted words are kept — an
 * event type like `loan.declined` is a valid query, not a link.)
 */
export function cleanQuery(query: string): string {
  return redactText(query).replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? [value] : [];
}

export async function semanticApplications(
  worldId: string,
  query: string,
  { size = 5, rerank = true, signal }: { size?: number; rerank?: boolean; signal?: AbortSignal } = {},
): Promise<ApplicationHit[]> {
  const client = elasticClient();
  if (!client) {
    throw new Error("Elastic is not configured");
  }
  const text = cleanQuery(query);
  if (!text) {
    return [];
  }
  const standard = {
    standard: {
      query: {
        bool: {
          must: { semantic: { field: "purpose", query: text } },
          filter: { term: { world_id: worldId } },
        },
      },
    },
  };
  const response = await client.search(
    {
      index: ELASTIC_INDICES.applications,
      size,
      _source: ["application_id", "agent_id", "decision", "amount_cents", "term_days", "reasons", "purpose_text", "sim_at"],
      retriever: rerank
        ? {
            text_similarity_reranker: {
              retriever: standard,
              field: "purpose_text",
              inference_id: JINA_RERANKER_ID,
              inference_text: text,
              rank_window_size: Math.max(20, size * 4),
            },
          }
        : standard,
    } as never,
    signal ? { signal } : {},
  );
  return response.hits.hits.map((hit) => {
    const s = (hit._source ?? {}) as Record<string, unknown>;
    return {
      application_id: String(s.application_id ?? hit._id),
      agent_id: String(s.agent_id ?? ""),
      decision: String(s.decision ?? ""),
      amount_cents: Number(s.amount_cents ?? 0),
      term_days: Number(s.term_days ?? 0),
      reasons: list(s.reasons),
      purpose: String(s.purpose_text ?? ""),
      sim_at: String(s.sim_at ?? ""),
      score: Number(hit._score ?? 0),
    };
  });
}

export async function keywordEvents(
  worldId: string,
  query: string,
  { size = 10, signal }: { size?: number; signal?: AbortSignal } = {},
): Promise<EventHit[]> {
  const client = elasticClient();
  if (!client) {
    throw new Error("Elastic is not configured");
  }
  const text = cleanQuery(query);
  if (!text) {
    return [];
  }
  const response = await client.search(
    {
      index: ELASTIC_INDICES.events,
      size,
      _source: ["type", "agent_id", "amount_cents", "reasons", "sim_at"],
      query: {
        bool: {
          filter: [{ term: { world_id: worldId } }],
          should: [
            { match: { text: { query: text, operator: "or" } } },
            { term: { type: { value: text.toLowerCase(), boost: 3 } } },
            { term: { reasons: { value: text.toLowerCase().replace(/\s+/g, "_"), boost: 2 } } },
          ],
          minimum_should_match: 1,
        },
      },
      sort: [{ _score: "desc" }, { sim_at: "desc" }],
    } as never,
    signal ? { signal } : {},
  );
  return response.hits.hits.map((hit) => {
    const s = (hit._source ?? {}) as Record<string, unknown>;
    return {
      type: String(s.type ?? ""),
      agent_id: typeof s.agent_id === "string" ? s.agent_id : null,
      amount_cents: typeof s.amount_cents === "number" ? s.amount_cents : null,
      reasons: list(s.reasons),
      sim_at: String(s.sim_at ?? ""),
      score: Number(hit._score ?? 0),
    };
  });
}
