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

/** 1-indexed line number containing `index` into `text`, plus a trimmed,
 * whitespace-collapsed snippet of the source line the match *starts* on
 * (useful for reporting even when the match itself spans several lines,
 * e.g. a multi-line method chain). */
function locate(text: string, index: number): { line: number; snippet: string } {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  const nextNewline = text.indexOf("\n", index);
  const rawLine = text.slice(lineStart, nextNewline === -1 ? text.length : nextNewline);
  return { line, snippet: rawLine.replace(/\s+/g, " ").trim() };
}

/**
 * Scans every `.ts` file under `rootDir` for direct world-table access
 * outside the allowlist, over each file's *whole text* (not line by
 * line) so a call broken across lines — e.g.
 * `db.select().from(\n  loans,\n)` — is still caught. Two shapes are
 * flagged, where `<worldTable>` is one of `worldTables` (the schema's
 * export identifiers, which is also what calling code imports and
 * references):
 *   - `.from(<worldTable>)`, `.insert(<worldTable>)`,
 *     `.update(<worldTable>)`, `.delete(<worldTable>)` — the
 *     query-builder entry points.
 *   - `.query.<worldTable>.` — Drizzle's relational query API
 *     (`db.query.loans.findMany()` etc.), a second way to read a table
 *     that bypasses `scoped()` just as much as `.from()` does.
 * Excluded: `scoped(tx, worldId).insert(<worldTable>, ...)` and the same
 * for `.update`/`.delete` — `scoped()`'s own methods happen to share
 * their names with Drizzle's query-builder entry points, and passing a
 * world table as their first argument is exactly how `scoped()` is
 * meant to be called (Ruling A — services must use it). A negative
 * lookbehind excludes only this specific receiver shape, so a *bare*
 * `db.insert(<worldTable>)`/`tx.insert(<worldTable>)` etc. is still
 * caught.
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

  const tableGroup = worldTables.join("|");
  // `\s*` around the identifier (and between the paren and it) tolerates
  // the call being wrapped across lines by a formatter. The leading
  // negative lookbehind excludes `scoped(...).insert/update/delete(` —
  // see the comment above.
  const builderPattern = new RegExp(
    `(?<!scoped\\([^()]*\\)\\s*)\\.\\s*(?:from|insert|update|delete)\\s*\\(\\s*(?:${tableGroup})\\b`,
    "g",
  );
  const relationalPattern = new RegExp(`\\.\\s*query\\s*\\.\\s*(?:${tableGroup})\\s*\\.`, "g");

  const violations: Violation[] = [];
  for (const file of walkTsFiles(rootDir)) {
    const relPath = relative(relativeTo, file);
    if (isAllowlisted(relPath)) continue;

    const text = readFileSync(file, "utf8");
    for (const pattern of [builderPattern, relationalPattern]) {
      for (const match of text.matchAll(pattern)) {
        const { line, snippet } = locate(text, match.index);
        violations.push({ file: relPath, line, text: snippet });
      }
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
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

    it("does not flag scoped(tx, worldId).insert/update/delete(<worldTable>, ...)", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "world-guard-fixture-"));
      const fixtureFile = join(fixtureDir, "scoped-writes.ts");
      writeFileSync(
        fixtureFile,
        [
          'import { scoped } from "../db/scoped";',
          'import { agents } from "../db/schema";',
          "",
          "export async function write(tx: unknown, worldId: string) {",
          "  await scoped(tx, worldId).insert(agents, {});",
          "  await scoped(tx, worldId).update(agents, {});",
          "  await scoped(tx, worldId).delete(agents, undefined as never);",
          "}",
          "",
        ].join("\n"),
      );

      const violations = scanForDirectWorldTableAccess(
        fixtureDir,
        fixtureDir,
        worldTables,
      );

      expect(violations).toEqual([]);
    });

    it("fails on a `.from(<worldTable>)` call broken across multiple lines", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "world-guard-fixture-"));
      const fixtureFile = join(fixtureDir, "leaky-multiline.ts");
      writeFileSync(
        fixtureFile,
        [
          'import { db } from "../db/client";',
          'import { loans } from "../db/schema";',
          "",
          "export async function leak() {",
          "  return db",
          "    .select()",
          "    .from(",
          "      loans,",
          "    );",
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
      expect(violations[0]?.file).toBe("leaky-multiline.ts");
      // `.from(` is on line 7; the match starts there even though
      // `loans` itself sits on the next line.
      expect(violations[0]?.line).toBe(7);
    });

    it("fails on a Drizzle relational `.query.<worldTable>.` call", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "world-guard-fixture-"));
      const fixtureFile = join(fixtureDir, "leaky-relational.ts");
      writeFileSync(
        fixtureFile,
        [
          'import { db } from "../db/client";',
          "",
          "export async function leak() {",
          "  return db.query.loans.findMany();",
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
      expect(violations[0]?.file).toBe("leaky-relational.ts");
      expect(violations[0]?.line).toBe(4);
      expect(violations[0]?.text).toContain(".query.loans.");
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
