import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
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
    },
  },
});
