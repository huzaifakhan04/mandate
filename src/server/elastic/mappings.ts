import type { Client } from "@elastic/elasticsearch";

import { ELASTIC_INDICES, JINA_EMBEDDINGS_ID } from "./config";

/**
 * P7: the three Risk Desk indices' mappings and their idempotent setup
 * (`scripts/elastic/setup.ts` runs `ensureElasticIndices`). Each index has
 * a composable index template (so a recreated index gets the same
 * mapping) and is created if missing; an existing index gets the mapping
 * again (additive — `put_mapping` with the same fields is a no-op).
 *
 * Nothing here holds PII: ids are uuids or keyed hashes (`hashId`),
 * free text is scrubbed before it is shipped (`elastic/docs.ts`).
 */

type Mapping = Record<string, unknown>;

const keyword = { type: "keyword" } as const;
const date = { type: "date" } as const;
const long = { type: "long" } as const;
const integer = { type: "integer" } as const;
const bool = { type: "boolean" } as const;

export const EVENTS_MAPPING: Mapping = {
  dynamic: "strict",
  properties: {
    doc_id: keyword,
    world_id: keyword,
    /** `event` (the events table), `agent` (registrations), `note_redemption` (redemption requests). */
    stream: keyword,
    type: keyword,
    aggregate_type: keyword,
    aggregate_id: keyword,
    agent_id: keyword,
    principal_hash: keyword,
    is_bot: bool,
    amount_cents: long,
    reasons: keyword,
    grade: keyword,
    score: integer,
    seq: long,
    sim_at: date,
    created_at: date,
    /** A short scrubbed description for keyword search. */
    text: { type: "text" },
  },
};

export const PAYPAL_OPS_MAPPING: Mapping = {
  dynamic: "strict",
  properties: {
    op_id: keyword,
    world_id: keyword,
    kind: keyword,
    purpose: keyword,
    status: keyword,
    rail: keyword,
    http_status: integer,
    attempts: integer,
    latency_ms: integer,
    amount_cents: long,
    loan_id: keyword,
    agent_id: keyword,
    is_bot: bool,
    /** The borrower's principal (hashed) and that principal's verified PayPal payer id (hashed). */
    borrower_principal_hash: keyword,
    borrower_payer_hash: keyword,
    /** Who approved / paid the order (hashed PayPal payer id). */
    payer_hash: keyword,
    created_at: date,
    updated_at: date,
  },
};

export const APPLICATIONS_MAPPING: Mapping = {
  dynamic: "strict",
  properties: {
    application_id: keyword,
    world_id: keyword,
    agent_id: keyword,
    principal_hash: keyword,
    is_bot: bool,
    amount_cents: long,
    term_days: integer,
    /** Semantic search over the stated purpose: Jina v5 embeddings, computed by Elastic at ingest. */
    purpose: { type: "semantic_text", inference_id: JINA_EMBEDDINGS_ID },
    /** The same scrubbed purpose as plain text (keyword search, reranking). */
    purpose_text: { type: "text" },
    decision: keyword,
    status: keyword,
    reasons: keyword,
    has_invoice: bool,
    grade: keyword,
    score: integer,
    sim_at: date,
    created_at: date,
  },
};

export const INDEX_MAPPINGS: Record<string, Mapping> = {
  [ELASTIC_INDICES.events]: EVENTS_MAPPING,
  [ELASTIC_INDICES.paypalOps]: PAYPAL_OPS_MAPPING,
  [ELASTIC_INDICES.applications]: APPLICATIONS_MAPPING,
};

export interface SetupReport {
  index: string;
  template: "put";
  index_created: boolean;
  mapping_updated: boolean;
}

/** Idempotent: templates put, indices created if missing, mappings re-applied. */
export async function ensureElasticIndices(client: Client): Promise<SetupReport[]> {
  const report: SetupReport[] = [];
  for (const [index, mapping] of Object.entries(INDEX_MAPPINGS)) {
    await client.indices.putIndexTemplate({
      name: `${index}-template`,
      index_patterns: [index],
      priority: 500,
      template: { mappings: mapping },
      _meta: { managed_by: "mandate-risk-desk" },
    });
    const exists = await client.indices.exists({ index });
    let created = false;
    if (!exists) {
      try {
        await client.indices.create({ index, mappings: mapping });
        created = true;
      } catch (err) {
        const type = (err as { meta?: { body?: { error?: { type?: string } } } }).meta?.body?.error?.type;
        if (type !== "resource_already_exists_exception") {
          throw err;
        }
      }
    }
    let mappingUpdated = false;
    if (!created) {
      const { properties, dynamic } = mapping as { properties: Record<string, unknown>; dynamic: "strict" };
      await client.indices.putMapping({ index, properties: properties as never, dynamic });
      mappingUpdated = true;
    }
    report.push({ index, template: "put", index_created: created, mapping_updated: mappingUpdated });
  }
  return report;
}
