import { globSync, readFileSync } from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

/**
 * Static guard for "no OpenAI call inside a DB transaction" (P3 Global
 * Constraints; Review Focus 2) — the AI twin of
 * tests/unit/paypal/noTransactionCalls.test.ts.
 *
 * `ai/run.ts` (`runRole`) and `ai/client.ts` make a network call of up to
 * 20 s. The rule:
 *
 * 1. Only the modules in `AI_CALLERS` may import them (value imports;
 *    `import type` is fine, and the pure `ai/schemas|templates|redact|
 *    policy` modules may be imported anywhere). An AI caller is an
 *    after-commit module: its functions take a plain `db`, and are called
 *    only from a tool's `finalize`, a `ctx.afterCommit` callback, or a
 *    route's `after()` — never from a `handler` or a `db.transaction`.
 *    Task 4 adds its narrative module here.
 * 2. An AI caller (and `src/server/ai/**` itself) never opens a
 *    transaction nor touches `ctx.tx`.
 * 3. Nowhere in `src/` is `runRole` handed a transaction (`runRole(tx`,
 *    `runRole(ctx.tx`).
 */

const ROOT = path.resolve(__dirname, "../../..");

/** After-commit modules allowed to import `ai/run` / `ai/client` (besides `src/server/ai/**`). */
const AI_CALLERS: string[] = [
  // P3 Task 4: apply_for_loan's `finalize` (loan officer, risk officer).
  "src/server/services/underwritingNarrative.ts",
  // P3 Task 4: the dashboard upload route's `after()` (KYA desk).
  "src/server/services/kyaDesk.ts",
  // P5 Task 3: the tick's daily treasury memo (after each world's work committed).
  "src/server/services/treasuryMemo.ts",
];

const AI_NETWORK_IMPORT_RE = /import\s+(?!type\b)[^;]*?from\s+["'][^"']*\/ai\/(run|client)["']/g;
const TRANSACTION_RE = /\.transaction\(|\bctx\.tx\b/;
const RUN_ROLE_WITH_TX_RE = /\brunRole\(\s*(ctx\.)?tx\b/;

/** Source without comments, so docs that *mention* the rule don't trip it. */
function code(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function sources(): string[] {
  return globSync("src/**/*.{ts,tsx}", { cwd: ROOT });
}

describe("OpenAI is never called inside a DB transaction", () => {
  it("only src/server/ai/** and the AI_CALLERS import ai/run or ai/client", () => {
    const importers = sources().filter((file) => {
      return [...code(file).matchAll(AI_NETWORK_IMPORT_RE)].length > 0;
    });
    const outsiders = importers.filter((file) => !file.startsWith("src/server/ai/") && !AI_CALLERS.includes(file));
    expect(outsiders).toEqual([]);
    // Every listed caller really is one (the list doesn't go stale).
    for (const file of AI_CALLERS) {
      expect(importers, file).toContain(file);
    }
  });

  it("the AI layer and the AI callers open no transaction and never touch ctx.tx", () => {
    const files = [...globSync("src/server/ai/**/*.ts", { cwd: ROOT }), ...AI_CALLERS];
    const offenders = files.filter((file) => TRANSACTION_RE.test(code(file)));
    expect(offenders).toEqual([]);
  });

  it("runRole is never handed a transaction anywhere in src/", () => {
    const offenders = sources().filter((file) => RUN_ROLE_WITH_TX_RE.test(code(file)));
    expect(offenders).toEqual([]);
  });

  it("the guard regexes catch each forbidden form", () => {
    const imports = [
      'import { runRole } from "@/server/ai/run";',
      'import { aiDisabled, openaiClient } from "../ai/client";',
      "import {\n  runRole,\n} from '@/server/ai/run';",
    ];
    for (const sample of imports) {
      expect([...sample.matchAll(AI_NETWORK_IMPORT_RE)]).toHaveLength(1);
    }
    expect([...'import type { RunRoleResult } from "@/server/ai/run";'.matchAll(AI_NETWORK_IMPORT_RE)]).toHaveLength(0);
    expect([...'import { loanOfficerTemplate } from "@/server/ai/templates";'.matchAll(AI_NETWORK_IMPORT_RE)]).toHaveLength(0);
    expect(TRANSACTION_RE.test("await db.transaction(async (tx) => {")).toBe(true);
    expect(TRANSACTION_RE.test("scoped(ctx.tx, worldId)")).toBe(true);
    expect(RUN_ROLE_WITH_TX_RE.test("await runRole(tx, worldId, 'loan_officer', input)")).toBe(true);
    expect(RUN_ROLE_WITH_TX_RE.test("await runRole(ctx.tx, worldId, 'loan_officer', input)")).toBe(true);
    expect(RUN_ROLE_WITH_TX_RE.test("await runRole(ctx.db, worldId, 'loan_officer', input)")).toBe(false);
  });
});
