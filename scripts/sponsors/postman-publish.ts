/**
 * P7 (Postman sponsor): builds the Mandate Postman collection from the live
 * /openapi.json + the local registry (folders, examples, auth), writes it to
 * docs/sponsors/postman/, and upserts it — plus a "Mandate prod" environment
 * — into the public Postman workspace (create, or update by name).
 *
 *   npx tsx --env-file=.env.local scripts/sponsors/postman-publish.ts [--base <url>] [--dry-run]
 *
 * Needs POSTMAN_API_KEY and POSTMAN_WORKSPACE_ID (never printed). --dry-run
 * only writes the JSON file. Prints the collection uid, the workspace's
 * public URL and the "Run in Postman" fork link.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

import { registry } from "../../src/server/contracts/registry";
import "../../src/server/contracts/tools";
import {
  buildPostmanCollection,
  buildPostmanEnvironment,
  POSTMAN_COLLECTION_NAME,
  POSTMAN_ENVIRONMENT_NAME,
} from "../../src/server/sponsors/postmanCollection";
import { POSTMAN_COLLECTION_UID, POSTMAN_WORKSPACE_ID, SPONSOR_LINKS } from "../../src/server/sponsors/links";

const API = "https://api.getpostman.com";
const OUT_DIR = resolve("docs/sponsors/postman");
const DEFAULT_BASE = "https://agentic-bank-mu.vercel.app";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set (run with --env-file=.env.local)`);
  }
  return value;
}

async function postman<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "X-Api-Key": env("POSTMAN_API_KEY"), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Postman ${method} ${path.split("?")[0]} → HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as T;
}

async function main(): Promise<void> {
  const base = (arg("--base") ?? DEFAULT_BASE).replace(/\/+$/, "");
  const dryRun = process.argv.includes("--dry-run");

  const openApiRes = await fetch(`${base}/openapi.json`);
  if (!openApiRes.ok) {
    throw new Error(`GET ${base}/openapi.json → HTTP ${openApiRes.status}`);
  }
  const openApi = (await openApiRes.json()) as { paths?: Record<string, unknown> };
  const live = Object.keys(openApi.paths ?? {}).map((p) => p.replace("/api/v1/", ""));
  const missing = registry.filter((t) => !live.includes(t.name)).map((t) => t.name);
  if (missing.length) {
    console.warn(`[postman] not in the live OpenAPI yet (using registry descriptions): ${missing.join(", ")}`);
  }

  const workspace = dryRun ? null : env("POSTMAN_WORKSPACE_ID");
  let existingUid: string | null = null;
  let existingId: string | undefined;
  if (workspace) {
    const list = await postman<{ collections: { uid: string; id: string; name: string }[] }>(
      "GET",
      `/collections?workspace=${encodeURIComponent(workspace)}`,
    );
    const found = list.collections.find((c) => c.name === POSTMAN_COLLECTION_NAME);
    existingUid = found?.uid ?? null;
    existingId = found?.id;
  }

  const collection = buildPostmanCollection(registry, { baseUrl: base, openApi: openApi as never, postmanId: existingId });

  // Committed copy (no _postman_id, so the file is stable across workspaces).
  mkdirSync(OUT_DIR, { recursive: true });
  const committed = buildPostmanCollection(registry, { baseUrl: base, openApi: openApi as never });
  const file = join(OUT_DIR, "mandate.postman_collection.json");
  writeFileSync(file, `${JSON.stringify(committed, null, 2)}\n`);
  writeFileSync(join(OUT_DIR, "mandate-prod.postman_environment.json"), `${JSON.stringify(buildPostmanEnvironment(base), null, 2)}\n`);
  const requests = committed.item.reduce((n, folder) => n + folder.item.length, 0);
  console.log(`[postman] wrote ${file} (${committed.item.length} folders, ${requests} requests)`);
  if (!workspace) {
    return;
  }

  let uid: string;
  if (existingUid) {
    await postman("PUT", `/collections/${existingUid}`, { collection });
    uid = existingUid;
    console.log(`[postman] updated collection ${uid}`);
  } else {
    const created = await postman<{ collection: { uid: string } }>(
      "POST",
      `/collections?workspace=${encodeURIComponent(workspace)}`,
      { collection },
    );
    uid = created.collection.uid;
    console.log(`[postman] created collection ${uid}`);
  }

  const envs = await postman<{ environments: { uid: string; name: string }[] }>(
    "GET",
    `/environments?workspace=${encodeURIComponent(workspace)}`,
  );
  const environment = buildPostmanEnvironment(base);
  const existingEnv = envs.environments.find((e) => e.name === POSTMAN_ENVIRONMENT_NAME);
  if (existingEnv) {
    await postman("PUT", `/environments/${existingEnv.uid}`, { environment });
    console.log(`[postman] updated environment ${existingEnv.uid}`);
  } else {
    const created = await postman<{ environment: { uid: string } }>(
      "POST",
      `/environments?workspace=${encodeURIComponent(workspace)}`,
      { environment },
    );
    console.log(`[postman] created environment ${created.environment.uid}`);
  }

  const ws = await postman<{ workspace: { id: string; name: string; visibility?: string; type?: string } }>(
    "GET",
    `/workspaces/${encodeURIComponent(workspace)}`,
  );
  const fork =
    `https://god.gw.postman.com/run-collection/${uid}?action=collection%2Ffork&source=rip_markdown&collection-url=` +
    `entityId%3D${uid}%26entityType%3Dcollection%26workspaceId%3D${ws.workspace.id}`;
  console.log(`[postman] workspace "${ws.workspace.name}" visibility=${ws.workspace.visibility ?? ws.workspace.type}`);
  console.log(`[postman] COLLECTION_UID=${uid}`);
  console.log(`[postman] WORKSPACE_ID=${ws.workspace.id}`);
  console.log(`[postman] RUN_IN_POSTMAN=${fork}`);
  if (uid !== POSTMAN_COLLECTION_UID || ws.workspace.id !== POSTMAN_WORKSPACE_ID) {
    console.warn("[postman] ids differ from src/server/sponsors/links.ts — update POSTMAN_COLLECTION_UID / POSTMAN_WORKSPACE_ID there.");
  } else {
    console.log(`[postman] public collection: ${SPONSOR_LINKS.postmanCollectionUrl}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
