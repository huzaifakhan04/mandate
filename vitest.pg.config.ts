import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * `npm run test:pg` — the money/concurrency suites against a REAL Postgres
 * (embedded-postgres, see tests/pg/globalSetup.ts) with genuinely
 * concurrent transactions on separate pool connections. `npm test` keeps
 * using PGlite.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globalSetup: ["tests/pg/globalSetup.ts"],
    setupFiles: ["tests/pg/setup.ts"],
    env: { TEST_PG: "1", TREASURY_POLICY_DISABLED: "1" },
    // The real-Postgres-only suites (concurrency with lock-wait proof,
    // migration dry run) plus the WHOLE unit suite re-run on real Postgres
    // — a superset of the money suites (loans, notes, repayments,
    // checkouts, reconcile, runTool idempotency/finalize, ledger).
    include: ["tests/pg/**/*.test.ts", "tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: 4,
  },
});
