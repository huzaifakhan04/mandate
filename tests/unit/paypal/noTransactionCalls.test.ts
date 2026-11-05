import { globSync, readFileSync } from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

/**
 * `paypalFetch` (and the request functions in `orders.ts`/`payouts.ts`
 * that call it) must never run inside a `db.transaction` — see the
 * JSDoc on `paypalFetch`. `src/server/paypal/operations.ts` is the one
 * sanctioned caller (`enqueueOperation` only ever writes a row inside
 * the caller's transaction; `executeOperation` is the thing that
 * actually calls PayPal, and the contract is that callers only invoke
 * it from `ctx.afterCommit`, after the transaction has committed).
 *
 * This is a cheap, static guard — not a runtime check (there's no
 * reliable way to ask a Drizzle `tx` "am I inside a transaction?") —
 * for the two kinds of code that must never reach for these functions
 * directly: service handlers (`src/server/services/**`) and contract/
 * tool handlers (`src/server/contracts/**`), which both run inside
 * `runTool`'s per-call transaction.
 */

const FORBIDDEN_IMPORT_RE =
  /from\s+["'][^"']*\/paypal\/(fetch|orders|payouts)["']/g;

const GUARDED_GLOBS = ["src/server/services/**/*.ts", "src/server/contracts/**/*.ts"];

function findViolations(): { file: string; line: string }[] {
  const root = path.resolve(__dirname, "../../..");
  const violations: { file: string; line: string }[] = [];

  for (const pattern of GUARDED_GLOBS) {
    const files = globSync(pattern, { cwd: root });
    for (const relativeFile of files) {
      const absoluteFile = path.join(root, relativeFile);
      const contents = readFileSync(absoluteFile, "utf8");
      const matches = contents.matchAll(FORBIDDEN_IMPORT_RE);
      for (const match of matches) {
        violations.push({ file: relativeFile, line: match[0] });
      }
    }
  }

  return violations;
}

describe("paypal fetch/orders/payouts are never imported from services or contracts", () => {
  it("only src/server/paypal/operations.ts may import fetch.ts/orders.ts/payouts.ts", () => {
    const violations = findViolations();
    expect(violations).toEqual([]);
  });
});
