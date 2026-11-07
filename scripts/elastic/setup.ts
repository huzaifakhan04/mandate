/**
 * P7 Risk Desk — idempotent Elastic setup.
 *
 *   npx tsx --env-file=.env.local scripts/elastic/setup.ts
 *
 * Puts the index templates and creates (or re-maps) the three indices
 * `mandate-events`, `mandate-paypal-ops`, `mandate-applications` (the last
 * with `purpose` as `semantic_text` on `.jina-embeddings-v5-text-small`),
 * then checks the Jina endpoints answer. Safe to run any number of times.
 * Prints index names and statuses only — never the URL or the API key.
 */
import { elasticClient } from "../../src/server/elastic/client";
import { JINA_EMBEDDINGS_ID, JINA_RERANKER_ID } from "../../src/server/elastic/config";
import { ensureElasticIndices } from "../../src/server/elastic/mappings";

async function main(): Promise<void> {
  const client = elasticClient();
  if (!client) {
    throw new Error("ELASTIC_URL / ELASTIC_API_KEY are not set (run with --env-file=.env.local).");
  }
  const info = await client.info();
  console.log(`cluster: ${info.version.build_flavor ?? "stack"} ${info.version.number}`);
  for (const row of await ensureElasticIndices(client)) {
    console.log(`${row.index}: template ${row.template}, ${row.index_created ? "index created" : "index exists, mapping re-applied"}`);
  }
  for (const id of [JINA_EMBEDDINGS_ID, JINA_RERANKER_ID]) {
    const endpoint = await client.inference.get({ inference_id: id });
    const first = endpoint.endpoints[0];
    console.log(`inference ${id}: ${first?.task_type ?? "missing"} (${first?.service ?? "?"})`);
  }
}

main().catch((err: unknown) => {
  console.error(`setup failed: ${err instanceof Error ? `${err.name}: ${err.message.split("\n")[0]}` : "unknown error"}`);
  process.exit(1);
});
