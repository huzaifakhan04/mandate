/**
 * P7 (APIMatic sponsor): validates Mandate's OpenAPI document with the
 * APIMatic API, imports it as an API entity (in place on reruns), generates
 * the TypeScript and Python SDKs, downloads the zips and unpacks them into
 * sdks/{typescript,python}; the zips are also copied to public/sdks/ so the
 * app serves them at /sdks. With --portal it also builds the static docs
 * portal into public/docs-portal/.
 *
 *   npx tsx --env-file=.env.local scripts/sponsors/apimatic-generate.ts [--from-live] [--base <url>] [--portal]
 *
 * By default the OpenAPI document is built from the local registry (what the
 * next deploy serves at /openapi.json); --from-live fetches <base>/openapi.json.
 * Needs APIMATIC_API_KEY (sent as `Authorization: X-Auth-Key …`, never printed).
 * Writes a non-secret run record to docs/sponsors/apimatic/last-run.json.
 *
 * API reference: https://docs.apimatic.io (Platform API, base https://api.apimatic.io):
 *   POST /validation/v2/validate-via-file                  (multipart: file)
 *   POST /api-entities/import-via-file                     (multipart: file)      → { id, ... }
 *   PUT  /api-entities/{id}/import-via-file                (multipart: file)      in-place re-import
 *   POST /api-entities/{id}/code-generations/generate      (form: template)       → { id, success, ... }
 *   GET  /api-entities/{id}/code-generations/{codegenId}/generated-sdk            → zip
 *   POST /portal/v2                                        (multipart: build-input zip) → { id }
 *   GET  /portal/v2/{id}/status, GET /portal/v2/{id}/download                    → portal zip
 * (GET /api-entities/{id}/on-prem-portal answered HTTP 500 and PUT …/hosted-portal 404 on this plan.)
 */
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";

import { buildOpenApiDocument } from "../../src/server/contracts/registry";
import "../../src/server/contracts/tools";

const API = "https://api.apimatic.io";
const DEFAULT_BASE = "https://mandate-bank.onrender.com";
const STATE_DIR = resolve("docs/sponsors/apimatic");
const STATE_FILE = join(STATE_DIR, "api-entity.json");
const SDK_DIR = resolve("sdks");
const PUBLIC_DIR = resolve("public/sdks");

const TARGETS = [
  { template: "TS_GENERIC_LIB", dir: "typescript", zip: "mandate-typescript-sdk.zip" },
  { template: "PYTHON_GENERIC_LIB", dir: "python", zip: "mandate-python-sdk.zip" },
] as const;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function auth(): Record<string, string> {
  const key = process.env.APIMATIC_API_KEY;
  if (!key) {
    throw new Error("APIMATIC_API_KEY is not set (run with --env-file=.env.local)");
  }
  return { Authorization: `X-Auth-Key ${key}` };
}

async function call(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> {
  const res = await fetch(`${API}${path}`, { method, headers: { ...auth(), ...init.headers }, body: init.body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`APIMatic ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return res;
}

function specForm(spec: string): FormData {
  const form = new FormData();
  form.append("file", new Blob([spec], { type: "application/json" }), "openapi.json");
  return form;
}

interface RunRecord {
  ranAt: string;
  source: string;
  apiEntityId: string | null;
  validation: { isSuccess: boolean; errors: number; warnings: number; lintWarnings: number } | null;
  sdks: { template: string; codegenId: string; success: boolean; zipBytes: number; dir: string }[];
  portal: { attempted: boolean; ok: boolean; detail: string };
  contextPlugin: string;
}

const BUILD_FILE = {
  $schema: "https://titan.apimatic.io/api/build/schema",
  buildFileVersion: "1",
  generatePortal: {
    apiSpecs: ["spec"],
    languageConfig: { typescript: {}, python: {}, http: {} },
    portalSettings: { enableExport: true },
  },
};

async function generatePortal(spec: string): Promise<string> {
  const work = resolve("test-results/apimatic-portal");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, "src/spec"), { recursive: true });
  writeFileSync(join(work, "src/spec/openapi.json"), spec);
  writeFileSync(join(work, "src/APIMATIC-BUILD.json"), JSON.stringify(BUILD_FILE, null, 2));
  execFileSync("zip", ["-q", "-r", "../build-input.zip", "src"], { cwd: work });
  const form = new FormData();
  form.append("file", new Blob([readFileSync(resolve("test-results/build-input.zip"))], { type: "application/zip" }), "build-input.zip");
  const started = (await (await call("POST", "/portal/v2", { body: form })).json()) as { id: string };
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5_000));
    const res = await call("GET", `/portal/v2/${started.id}/status`);
    const type = res.headers.get("content-type") ?? "";
    // In progress → {"status":"InProgress"}; done → the status call already streams the zip.
    if (type.includes("json")) {
      const status = ((await res.json()) as { status?: string }).status;
      if (status && /fail|error/i.test(status)) {
        throw new Error(`portal generation ${started.id}: ${status}`);
      }
      continue;
    }
    await res.arrayBuffer();
    const zip = Buffer.from(await (await call("GET", `/portal/v2/${started.id}/download`)).arrayBuffer());
    const zipPath = resolve("test-results/apimatic-portal.zip");
    writeFileSync(zipPath, zip);
    const out = resolve("public/docs-portal");
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    execFileSync("unzip", ["-q", "-o", zipPath, "-d", out]);
    return `portal ${started.id}: ${zip.length}-byte zip → public/docs-portal/ (served at /docs-portal/index.html)`;
  }
  throw new Error(`portal generation ${started.id} did not finish in 5 minutes`);
}

async function main(): Promise<void> {
  const base = (arg("--base") ?? DEFAULT_BASE).replace(/\/+$/, "");
  const fromLive = process.argv.includes("--from-live");
  const record: RunRecord = {
    ranAt: new Date().toISOString(),
    source: fromLive ? `${base}/openapi.json` : "local registry (buildOpenApiDocument)",
    apiEntityId: null,
    validation: null,
    sdks: [],
    portal: { attempted: false, ok: false, detail: "not requested (pass --portal)" },
    contextPlugin:
      "PayPal Context Plugin (APIMatic ContextMatic) is an MCP server for coding agents (https://chatbotapi.apimatic.io/mcp/plugins; " +
      "Claude Code: /plugin marketplace add apimatic/context-matic) — it is not part of the Platform API, so it is not called here.",
  };

  const spec = fromLive
    ? await (await fetch(`${base}/openapi.json`)).text()
    : JSON.stringify(buildOpenApiDocument(base), null, 2);

  // 1. Validate.
  const validation = (await (await call("POST", "/validation/v2/validate-via-file", { body: specForm(spec) })).json()) as {
    validation: { isSuccess: boolean; errors: unknown[]; warnings: unknown[] };
    linting?: { warnings: unknown[] };
  };
  record.validation = {
    isSuccess: validation.validation.isSuccess,
    errors: validation.validation.errors.length,
    warnings: validation.validation.warnings.length,
    lintWarnings: validation.linting?.warnings.length ?? 0,
  };
  console.log(`[apimatic] validation: ${JSON.stringify(record.validation)}`);
  if (!validation.validation.isSuccess) {
    throw new Error("APIMatic rejected the OpenAPI document");
  }

  // 2. Import (in place when we already have an entity).
  mkdirSync(STATE_DIR, { recursive: true });
  const known = existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as { apiEntityId?: string }).apiEntityId : undefined;
  let entityId: string;
  if (known) {
    await call("PUT", `/api-entities/${known}/import-via-file`, { body: specForm(spec), headers: { Accept: "application/json" } });
    entityId = known;
    console.log(`[apimatic] re-imported API entity ${entityId}`);
  } else {
    const created = (await (
      await call("POST", "/api-entities/import-via-file", { body: specForm(spec), headers: { Accept: "application/json" } })
    ).json()) as { id: string };
    entityId = created.id;
    console.log(`[apimatic] imported API entity ${entityId}`);
  }
  record.apiEntityId = entityId;
  writeFileSync(STATE_FILE, `${JSON.stringify({ apiEntityId: entityId, name: "Mandate Bank API" }, null, 2)}\n`);

  // 3. Generate + download + unpack each SDK.
  mkdirSync(PUBLIC_DIR, { recursive: true });
  for (const target of TARGETS) {
    const form = new URLSearchParams({ template: target.template });
    const generated = (await (
      await call("POST", `/api-entities/${entityId}/code-generations/generate`, {
        body: form,
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      })
    ).json()) as { id: string; success: boolean };
    const zip = Buffer.from(
      await (await call("GET", `/api-entities/${entityId}/code-generations/${generated.id}/generated-sdk`)).arrayBuffer(),
    );
    const zipPath = join(PUBLIC_DIR, target.zip);
    writeFileSync(zipPath, zip);
    const out = join(SDK_DIR, target.dir);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    execFileSync("unzip", ["-q", "-o", zipPath, "-d", out]);
    record.sdks.push({ template: target.template, codegenId: generated.id, success: generated.success, zipBytes: zip.length, dir: `sdks/${target.dir}` });
    console.log(`[apimatic] ${target.template}: codegen ${generated.id} success=${generated.success}, ${zip.length} bytes → sdks/${target.dir}, public/sdks/${target.zip}`);
  }

  // 4. Optional: the docs portal — a static site built from a "build input" zip
  //    (src/APIMATIC-BUILD.json + src/spec/openapi.json) via the async Portal API,
  //    unpacked into public/docs-portal/ (served at /docs-portal/index.html).
  if (process.argv.includes("--portal")) {
    record.portal.attempted = true;
    try {
      record.portal = { attempted: true, ok: true, detail: await generatePortal(spec) };
    } catch (err) {
      record.portal = { attempted: true, ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    console.log(`[apimatic] portal: ${record.portal.detail}`);
  }

  writeFileSync(join(STATE_DIR, "last-run.json"), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`[apimatic] wrote docs/sponsors/apimatic/last-run.json`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
