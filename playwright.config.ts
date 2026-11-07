import { defineConfig } from "@playwright/test";

// `E2E_PORT=3100 npm run e2e` when something else already listens on 3000
// (reuseExistingServer would otherwise test that other server).
const port = Number(process.env.E2E_PORT || 3000);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL,
  },
  webServer: {
    command: `npm run dev -- -p ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Neon is not provisioned for local/e2e runs, so force the API routes'
    // `getDb()` resolver onto its in-memory PGlite dev fallback even when
    // `.env.local` sets `DATABASE_URL` (e.g. for other tooling). An empty
    // string is falsy, and Next.js never lets a `.env.local` value override
    // an already-set process env var.
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ),
      DATABASE_URL: "",
      // Tools that create/verify API keys need a pepper; .env.local may not
      // carry one for local runs. Test-only value; never a real secret.
      API_KEY_PEPPER: process.env.API_KEY_PEPPER || "e2e-test-pepper",
      // P2 Task 5: the owner journey signs in through the env-gated
      // POST /api/test/session (the main world is on the real PayPal rail,
      // so a browser can't approve a sandbox order here). 404 in production.
      MANDATE_TEST_ENDPOINTS: "1",
      // P3 Task 4: the AI roles (KYA desk after an upload, loan officer
      // after an apply) use their templates — e2e never calls OpenAI, even
      // when `.env.local` carries a key. `E2E_OPENAI=1` opts in.
      OPENAI_DISABLED: process.env.E2E_OPENAI === "1" ? "" : "1",
      // P8: the specs share one dev server, one PGlite and one client IP, so
      // the Postgres-backed rate limits (10 registrations per IP per hour, …)
      // are off here; unit + test:pg suites cover them. `E2E_RATE_LIMITS=1` opts in.
      RATE_LIMITS_DISABLED: process.env.E2E_RATE_LIMITS === "1" ? "" : "1",
    },
  },
});
