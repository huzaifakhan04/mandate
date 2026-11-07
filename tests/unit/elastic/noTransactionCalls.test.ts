import { globSync, readFileSync } from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

/**
 * P7: static guard for "Elastic is never called inside a DB transaction"
 * — the Elastic twin of tests/unit/ai/noTransactionCalls.test.ts.
 *
 * 1. Only `src/server/elastic/**` and the `ELASTIC_CALLERS` may import the
 *    Elastic network modules (`elastic/client|ship|esql|search|detectors|
 *    mappings`); `elastic/config` and `elastic/docs` are pure and may be
 *    imported anywhere (`import type` is always fine). An Elastic caller
 *    is an after-commit module: plain `db`, called from the tick (after
 *    each world's work committed) or a route — never from a tool
 *    `handler` or inside `db.transaction`.
 * 2. The Elastic layer and its callers never open a transaction nor touch
 *    `ctx.tx`.
 * 3. Contract/tool code never imports the Elastic layer at all.
 */

const ROOT = path.resolve(__dirname, "../../..");

const ELASTIC_CALLERS: string[] = [
  // The tick's Risk Desk step: ship, detect hourly, investigate.
  "src/server/services/riskDesk.ts",
  // The risk investigator's tools (ES|QL templates, semantic search).
  "src/server/services/riskInvestigation.ts",
  // The console's search box route.
  "src/server/services/consoleSearch.ts",
];

const ELASTIC_NETWORK_IMPORT_RE =
  /import\s+(?!type\b)[^;]*?from\s+["'][^"']*\/elastic\/(client|ship|esql|search|detectors|mappings)["']/g;
const ANY_ELASTIC_IMPORT_RE = /from\s+["'][^"']*\/elastic\/[a-z]+["']/;
const TRANSACTION_RE = /\.transaction\(|\bctx\.tx\b/;

function code(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function sources(): string[] {
  return globSync("src/**/*.{ts,tsx}", { cwd: ROOT });
}

describe("Elastic is never called inside a DB transaction", () => {
  it("only src/server/elastic/** and the ELASTIC_CALLERS import the Elastic network modules", () => {
    const importers = sources().filter((file) => [...code(file).matchAll(ELASTIC_NETWORK_IMPORT_RE)].length > 0);
    const outsiders = importers.filter((file) => !file.startsWith("src/server/elastic/") && !ELASTIC_CALLERS.includes(file));
    expect(outsiders).toEqual([]);
    for (const file of ELASTIC_CALLERS) {
      expect(importers, file).toContain(file);
    }
  });

  it("the Elastic layer and its callers open no transaction and never touch ctx.tx", () => {
    const files = [...globSync("src/server/elastic/**/*.ts", { cwd: ROOT }), ...ELASTIC_CALLERS];
    expect(files.length).toBeGreaterThan(5);
    const offenders = files.filter((file) => TRANSACTION_RE.test(code(file)));
    expect(offenders).toEqual([]);
  });

  it("contracts and tools never import the Elastic layer", () => {
    const offenders = globSync("src/server/contracts/**/*.ts", { cwd: ROOT }).filter((file) => ANY_ELASTIC_IMPORT_RE.test(code(file)));
    expect(offenders).toEqual([]);
  });

  it("the guard regex catches each forbidden form", () => {
    for (const sample of [
      'import { shipWorld } from "../elastic/ship";',
      'import { runEsqlTemplate } from "@/server/elastic/esql";',
      "import {\n  elasticClient,\n} from '../../elastic/client';",
    ]) {
      expect([...sample.matchAll(ELASTIC_NETWORK_IMPORT_RE)]).toHaveLength(1);
    }
    expect([...'import type { EsqlResult } from "../elastic/esql";'.matchAll(ELASTIC_NETWORK_IMPORT_RE)]).toHaveLength(0);
    expect([...'import { hashId } from "../elastic/config";'.matchAll(ELASTIC_NETWORK_IMPORT_RE)]).toHaveLength(0);
  });
});
