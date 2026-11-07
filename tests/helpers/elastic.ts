/**
 * P7 test helpers: a fake Elasticsearch behind msw (no network). Every
 * response carries `x-elastic-product: Elasticsearch` (the official client
 * checks it). `stubElastic()` points ELASTIC_URL / ELASTIC_API_KEY at the
 * fake and resets the cached client.
 */
import { http, HttpResponse } from "msw";
import type { SetupServer } from "msw/node";
import { vi } from "vitest";

import { __resetElasticClientForTests } from "@/server/elastic/client";

export const ELASTIC_TEST_URL = "http://elastic.test:9200";
const HEADERS = { "x-elastic-product": "Elasticsearch", "content-type": "application/json" };

export function stubElastic(): void {
  vi.stubEnv("ELASTIC_URL", ELASTIC_TEST_URL);
  vi.stubEnv("ELASTIC_API_KEY", "test-elastic-key");
  vi.stubEnv("ELASTIC_DISABLED", "");
  __resetElasticClientForTests();
}

export function unstubElastic(): void {
  vi.stubEnv("ELASTIC_URL", "");
  vi.stubEnv("ELASTIC_API_KEY", "");
  __resetElasticClientForTests();
}

export function esJson(body: unknown, status = 200) {
  return HttpResponse.json(body as never, { status, headers: HEADERS });
}

export interface BulkCapture {
  requests: Array<Array<{ action: Record<string, { _index: string; _id: string }>; doc: Record<string, unknown> }>>;
  docs(): Array<{ index: string; id: string; doc: Record<string, unknown> }>;
}

/** Accepts every bulk (or fails item `failAt` / the whole request with `status`). */
export function captureBulk(server: SetupServer, opts: { status?: number; failAt?: number } = {}): BulkCapture {
  const capture: BulkCapture = {
    requests: [],
    docs() {
      return capture.requests.flat().map((r) => {
        const meta = Object.values(r.action)[0]!;
        return { index: meta._index, id: meta._id, doc: r.doc };
      });
    },
  };
  server.use(
    http.post(`${ELASTIC_TEST_URL}/_bulk`, async ({ request }) => {
      const lines = (await request.text()).split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
      const pairs = [];
      for (let i = 0; i < lines.length; i += 2) pairs.push({ action: lines[i], doc: lines[i + 1] });
      if (opts.status && opts.status >= 400) {
        return esJson({ error: { type: "cluster_block_exception", reason: "test" }, status: opts.status }, opts.status);
      }
      capture.requests.push(pairs);
      const items = pairs.map((p, i) => {
        const meta = Object.values(p.action)[0] as { _index: string; _id: string };
        return opts.failAt === i
          ? { index: { _index: meta._index, _id: meta._id, status: 400, error: { type: "document_parsing_exception", reason: "test" } } }
          : { index: { _index: meta._index, _id: meta._id, status: 201, result: "created" } };
      });
      return esJson({ took: 1, errors: items.some((it) => "error" in it.index), items });
    }),
  );
  return capture;
}

export type EsqlRows = Array<Record<string, unknown>>;

/**
 * Answers `POST /_query` by matching the query text: the first matcher
 * whose `includes` string is in the query returns its rows (columns are
 * the rows' keys). Unmatched queries return no rows. Records each call.
 */
export function fakeEsql(server: SetupServer, matchers: Array<{ includes: string; rows: EsqlRows | ((params: Record<string, unknown>) => EsqlRows) }>) {
  const calls: Array<{ query: string; params: Record<string, unknown> }> = [];
  server.use(
    http.post(`${ELASTIC_TEST_URL}/_query`, async ({ request }) => {
      const body = (await request.json()) as { query: string; params?: Array<Record<string, unknown>> };
      const params = Object.assign({}, ...(body.params ?? []));
      calls.push({ query: body.query, params });
      const matcher = matchers.find((m) => body.query.includes(m.includes));
      const rows = matcher ? (typeof matcher.rows === "function" ? matcher.rows(params) : matcher.rows) : [];
      const columns = rows.length ? Object.keys(rows[0]!) : ["none"];
      return esJson({
        took: 1,
        is_partial: false,
        columns: columns.map((name) => ({ name, type: "keyword" })),
        values: rows.map((r) => columns.map((c) => r[c] ?? null)),
      });
    }),
  );
  return calls;
}

/** Answers `_search` on an index with the given `_source` hits. */
export function fakeSearch(server: SetupServer, index: string, hits: Array<Record<string, unknown>>) {
  const calls: unknown[] = [];
  server.use(
    http.post(`${ELASTIC_TEST_URL}/${index}/_search`, async ({ request }) => {
      calls.push(await request.json());
      return esJson({
        took: 1,
        timed_out: false,
        hits: { total: { value: hits.length, relation: "eq" }, max_score: 1, hits: hits.map((h, i) => ({ _index: index, _id: String(i), _score: 1 - i / 10, _source: h })) },
      });
    }),
  );
  return calls;
}
