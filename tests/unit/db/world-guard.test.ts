import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative, sep } from "path";

import { isTable } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";

/**
 * Files/directories allowed to touch world tables directly instead of
 * going through `scoped()`. Everything else under `src/server/**` must
 * use `scoped()` so `world_id` is always injected/filtered, never
 * forgotten (see src/server/db/scoped.ts's header comment — Ruling A in
 * .superpowers/sdd/2026-11-06-p1-core-loop/progress.md).
 */
const ALLOWLISTED_DIRS = [
  "src/server/db",
  "src/server/ledger",
  "src/server/paypal",
  "src/server/rail",
  "src/server/auth",
  "src/server/clock",
];

const ALLOWLISTED_FILES = [
  // Owns the main-world bootstrap/memoization that every `auth: 'none'`
  // tool call and `scoped()` itself depend on — infrastructure, like auth.
  "src/server/services/worlds.ts",
  // Claim-first idempotency bookkeeping shared by every mutating tool
  // call (runTool.ts), reading/writing `idempotency_keys` directly before
  // a world/tx/scoped() even exists for the call — infrastructure, like
  // auth. (Added since Task 1; see controller notes for Task 3.)
  "src/server/contracts/runTool.ts",
];

function isAllowlisted(relPath: string): boolean {
  const normalized = relPath.split(sep).join("/");
  if (ALLOWLISTED_FILES.includes(normalized)) return true;
  return ALLOWLISTED_DIRS.some(
    (dir) => normalized === dir || normalized.startsWith(`${dir}/`),
  );
}

function worldTableIdentifiers(): string[] {
  return Object.entries(schema)
    .filter(([, value]) => isTable(value))
    .filter(([, value]) =>
      getTableConfig(value as PgTable).columns.some(
        (column) => column.name === "world_id",
      ),
    )
    .map(([exportName]) => exportName);
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

/**
 * Scans every `.ts` file under `rootDir` for `.from(<worldTable>)`,
 * `.insert(<worldTable>)`, `.update(<worldTable>)` or
 * `.delete(<worldTable>)` where `<worldTable>` is one of `worldTables`
 * (the schema's export identifiers, which is also what calling code
 * imports and references), and reports every hit outside the allowlist.
 * `relativeTo` is the base that allowlist paths are resolved against.
 */
function scanForDirectWorldTableAccess(
  rootDir: string,
  relativeTo: string,
  worldTables: string[],
): Violation[] {
  if (worldTables.length === 0) {
    throw new Error("worldTables must not be empty — the scan would be a no-op");
  }

  const tablePattern = new RegExp(
    `\\.(from|insert|update|delete)\\(\\s*(${worldTables.join("|")})\\b`,
  );

  const violations: Violation[] = [];
  for (const file of walkTsFiles(rootDir)) {
    const relPath = relative(relativeTo, file);
    if (isAllowlisted(relPath)) continue;

    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((lineText, index) => {
      if (tablePattern.test(lineText)) {
        violations.push({ file: relPath, line: index + 1, text: lineText.trim() });
      }
    });
  }
  return violations;
}

const repoRoot = process.cwd();
const worldTables = worldTableIdentifiers();

describe("world-isolation guard", () => {
  it("derives a non-trivial list of world-scoped tables from schema.ts", () => {
    // Sanity check so a schema.ts refactor that breaks the derivation
    // (e.g. renamed exports, `isTable` no longer matching) fails loudly
    // here instead of silently scanning for zero tables.
    expect(worldTables.length).toBeGreaterThanOrEqual(20);
    expect(worldTables).toContain("agents");
    expect(worldTables).toContain("loans");
    expect(worldTables).toContain("idempotencyKeys");
    // `worlds`/`principals` have no world_id column and must not appear.
    expect(worldTables).not.toContain("worlds");
    expect(worldTables).not.toContain("principals");
  });

  it("passes on the current src/server tree", () => {
    const violations = scanForDirectWorldTableAccess(
      join(repoRoot, "src/server"),
      repoRoot,
      worldTables,
    );

    expect(
      violations,
      `Found direct world-table access outside the scoped() allowlist:\n${violations
        .map((v) => `  ${v.file}:${v.line}: ${v.text}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  describe("against a fixture outside the allowlist", () => {
    let fixtureDir: string | undefined;

    afterEach(() => {
      if (fixtureDir) {
        rmSync(fixtureDir, { recursive: true, force: true });
        fixtureDir = undefined;
      }
    });

    it("fails on direct `.from(<worldTable>)` access", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "world-guard-fixture-"));
      const fixtureFile = join(fixtureDir, "leaky-service.ts");
      writeFileSync(
        fixtureFile,
        [
          'import { db } from "../db/client";',
          'import { loans } from "../db/schema";',
          "",
          "export async function leak() {",
          "  return db.select().from(loans);",
          "}",
          "",
        ].join("\n"),
      );

      const violations = scanForDirectWorldTableAccess(
        fixtureDir,
        fixtureDir,
        worldTables,
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.file).toBe("leaky-service.ts");
      expect(violations[0]?.line).toBe(5);
      expect(violations[0]?.text).toContain(".from(loans)");
    });

    it("fails on direct `.insert(<worldTable>)`, `.update(<worldTable>)` and `.delete(<worldTable>)` access", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "world-guard-fixture-"));
      const fixtureFile = join(fixtureDir, "leaky-writes.ts");
      writeFileSync(
        fixtureFile,
        [
          'import { db } from "../db/client";',
          'import { agents } from "../db/schema";',
          "",
          "export async function leakWrites() {",
          "  await db.insert(agents).values({});",
          "  await db.update(agents).set({});",
          "  await db.delete(agents);",
          "}",
          "",
        ].join("\n"),
      );

      const violations = scanForDirectWorldTableAccess(
        fixtureDir,
        fixtureDir,
        worldTables,
      );

      expect(violations.map((v) => v.line)).toEqual([5, 6, 7]);
    });

    it("does not flag a fixture path that happens to sit under an allowlisted directory name", () => {
      // Sanity check for the allowlist matcher itself: a fixture rooted
      // outside the repo never collides with `src/server/db` etc., so
      // this just confirms the fixture harness above isn't accidentally
      // allowlisting everything by matching on basename only.
      fixtureDir = mkdtempSync(join(tmpdir(), "world-guard-fixture-"));
      expect(statSync(fixtureDir).isDirectory()).toBe(true);
      expect(isAllowlisted(relative(repoRoot, fixtureDir))).toBe(false);
    });
  });
});
