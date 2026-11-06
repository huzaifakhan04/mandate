import { globSync, readFileSync } from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

/**
 * Static guards for the money-movement rule (never call PayPal inside a
 * DB transaction) and for Ruling H (operations.ts owns every
 * `paypal_operations` status write):
 *
 * 1. Services and contract/tool handlers run inside `runTool`'s per-call
 *    transaction, so they must never reach PayPal directly. They may not
 *    import `paypal/fetch|orders|payouts` nor the rails
 *    (`rail/paypalRail|simRail|simHandler|operationRail`); they use
 *    `paypal/operations` only — `enqueueOperation(ctx.tx, …)` inside the
 *    transaction, `executeOperation(ctx.db, …)` from `ctx.afterCommit`.
 *    There's no reliable runtime "am I in a transaction?" check on a
 *    Drizzle `tx`, hence a cheap static one.
 * 2. Only `paypal/operations.ts` (and the sim handler, which it calls)
 *    may write `paypal_operations`; `paypal/fetch.ts` is a pure HTTP
 *    client and must not touch the database at all.
 */

const ROOT = path.resolve(__dirname, "../../..");

const FORBIDDEN_IMPORT_RE =
  /from\s+["'][^"']*\/(paypal\/(fetch|orders|payouts)|rail\/(paypalRail|simRail|simHandler|operationRail))["']/g;

const GUARDED_GLOBS = ["src/server/services/**/*.ts", "src/server/contracts/**/*.ts", "src/server/jobs/**/*.ts"];

function findViolations(): { file: string; line: string }[] {
  const violations: { file: string; line: string }[] = [];
  for (const pattern of GUARDED_GLOBS) {
    for (const relativeFile of globSync(pattern, { cwd: ROOT })) {
      const contents = readFileSync(path.join(ROOT, relativeFile), "utf8");
      for (const match of contents.matchAll(FORBIDDEN_IMPORT_RE)) {
        violations.push({ file: relativeFile, line: match[0] });
      }
    }
  }
  return violations;
}

describe("PayPal is only reached through paypal/operations", () => {
  it("services and contracts import neither paypal/fetch|orders|payouts nor the rails", () => {
    expect(findViolations()).toEqual([]);
  });

  it("the guard regex catches each forbidden import form", () => {
    const samples = [
      'import { paypalFetch } from "@/server/paypal/fetch";',
      'import * as orders from "../paypal/orders";',
      'import { send } from "../../paypal/payouts";',
      'import { paypalRail } from "@/server/rail/paypalRail";',
      'import { simRail } from "../rail/simRail";',
      'import { simHandle } from "@/server/rail/simHandler";',
    ];
    for (const sample of samples) {
      expect([...sample.matchAll(FORBIDDEN_IMPORT_RE)]).toHaveLength(1);
    }
    expect([
      ...'import { enqueueOperation } from "@/server/paypal/operations";'.matchAll(
        FORBIDDEN_IMPORT_RE,
      ),
    ]).toHaveLength(0);
  });

  it("paypal/fetch.ts is a pure HTTP client: it imports no database code", () => {
    const source = readFileSync(path.join(ROOT, "src/server/paypal/fetch.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*\/db\//);
    expect(source).not.toMatch(/paypalOperations/);
  });

  it("only paypal/operations.ts and rail/simHandler.ts write the paypal_operations table in src/server", () => {
    // Reading rows (outcome appliers, reconcile) is fine; writing them is not.
    const WRITE_RE = /\.(insert|update|delete)\(\s*(paypalOperations|t)\b/;
    const writers = globSync("src/server/**/*.ts", { cwd: ROOT }).filter((file) => {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      return /\bpaypalOperations\b/.test(source) && WRITE_RE.test(source);
    });
    expect(writers.sort()).toEqual(["src/server/paypal/operations.ts", "src/server/rail/simHandler.ts"]);
  });
});
