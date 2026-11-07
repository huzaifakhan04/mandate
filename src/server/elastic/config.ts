import { createHmac } from "crypto";

/**
 * P7 Risk Desk — Elastic configuration (pure: no network, no database).
 *
 * Elastic is optional. With `ELASTIC_URL` or `ELASTIC_API_KEY` unset (or
 * `ELASTIC_DISABLED=1`) the outbox shipping, the detectors and the
 * console search are all disabled and the console says so; nothing else
 * in the bank depends on Elastic.
 */

export const ELASTIC_INDICES = {
  events: "mandate-events",
  paypalOps: "mandate-paypal-ops",
  applications: "mandate-applications",
} as const;

export type ElasticIndex = (typeof ELASTIC_INDICES)[keyof typeof ELASTIC_INDICES];

/** Jina embeddings (semantic_text on `mandate-applications.purpose`) and the Jina reranker. */
export const JINA_EMBEDDINGS_ID = ".jina-embeddings-v5-text-small";
export const JINA_RERANKER_ID = ".jina-reranker-v3";

/** At most this many documents per world per tick, across all streams. */
export const SHIP_BATCH_PER_WORLD = 500;

/** Per-request timeout for every Elastic call (the tick runs within a 60 s function). */
export const ELASTIC_REQUEST_TIMEOUT_MS = 10_000;

export function elasticConfigured(): boolean {
  return (
    process.env.ELASTIC_DISABLED !== "1" &&
    Boolean(process.env.ELASTIC_URL?.trim()) &&
    Boolean(process.env.ELASTIC_API_KEY?.trim())
  );
}

/** The note the console shows when Elastic is off. */
export const ELASTIC_DISABLED_NOTE =
  "Risk Desk offline: Elastic is not configured here, so event shipping, risk detectors and search are disabled.";

function hashSecret(): string {
  return process.env.RISK_HASH_SECRET || process.env.SESSION_SECRET || "mandate-risk-desk";
}

/**
 * A keyed, truncated hash of an identifier (a PayPal payer id, a principal
 * id) — what leaves the bank instead of the identifier itself. Equal
 * inputs give equal hashes (the detectors compare them), but the raw id
 * can't be read back. `null` in, `null` out.
 */
export function hashId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return `h_${createHmac("sha256", `mandate-risk:${hashSecret()}`).update(value).digest("hex").slice(0, 24)}`;
}
