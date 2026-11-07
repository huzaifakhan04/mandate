import { Client, HttpConnection } from "@elastic/elasticsearch";

import { ELASTIC_REQUEST_TIMEOUT_MS, elasticConfigured } from "./config";

/**
 * The official `@elastic/elasticsearch` client, created lazily from
 * `ELASTIC_URL` + `ELASTIC_API_KEY` (re-created when either changes, e.g.
 * between tests). Node's `http` connection (not undici) so tests can
 * intercept it with msw. One retry, a 10 s request timeout.
 *
 * RULE: like PayPal and OpenAI, Elastic is never called inside a DB
 * transaction — tests/unit/elastic/noTransactionCalls.test.ts enforces it.
 */

let client: Client | null = null;
let clientKey: string | null = null;

export function elasticClient(): Client | null {
  if (!elasticConfigured()) {
    return null;
  }
  const node = process.env.ELASTIC_URL!.trim();
  const apiKey = process.env.ELASTIC_API_KEY!.trim();
  const key = `${node}\n${apiKey}`;
  if (!client || clientKey !== key) {
    client = new Client({
      node,
      auth: { apiKey },
      Connection: HttpConnection,
      requestTimeout: ELASTIC_REQUEST_TIMEOUT_MS,
      maxRetries: 1,
      compression: false,
    });
    clientKey = key;
  }
  return client;
}

/** Test hook: forget the cached client. */
export function __resetElasticClientForTests(): void {
  client = null;
  clientKey = null;
}

/** A short, secret-free description of an Elastic failure (for logs, job_runs and cursors). */
export function elasticErrorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { name?: string; meta?: { statusCode?: number }; body?: unknown; message?: string };
    const status = e.meta?.statusCode;
    const name = e.name ?? "Error";
    const type =
      e.meta && typeof (e.meta as { body?: unknown }).body === "object"
        ? ((e.meta as { body?: { error?: { type?: string } } }).body?.error?.type ?? null)
        : null;
    return [name, status ? `http_${status}` : null, type].filter(Boolean).join(" ");
  }
  return "unknown error";
}
