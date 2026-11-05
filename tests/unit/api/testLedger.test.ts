import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestLedgerHandler } from "@/app/api/test/ledger/route";
import { createTestDb } from "@/server/db/testing";

describe("test-only GET /api/test/ledger", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("404s by default (MANDATE_TEST_ENDPOINTS unset), without touching the db", async () => {
    vi.stubEnv("MANDATE_TEST_ENDPOINTS", "");
    const getDb = vi.fn(createTestDb);
    const res = await createTestLedgerHandler({ getDb }).GET();
    expect(res.status).toBe(404);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("404s for any value other than 1", async () => {
    vi.stubEnv("MANDATE_TEST_ENDPOINTS", "true");
    const res = await createTestLedgerHandler({ getDb: createTestDb }).GET();
    expect(res.status).toBe(404);
  });

  it("404s in production even when enabled", async () => {
    vi.stubEnv("MANDATE_TEST_ENDPOINTS", "1");
    vi.stubEnv("NODE_ENV", "production");
    const res = await createTestLedgerHandler({ getDb: createTestDb }).GET();
    expect(res.status).toBe(404);
  });

  it("with MANDATE_TEST_ENDPOINTS=1 returns the main world's trial balance and operation counts", async () => {
    vi.stubEnv("MANDATE_TEST_ENDPOINTS", "1");
    const db = await createTestDb();
    const res = await createTestLedgerHandler({ getDb: async () => db }).GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.report.trial_balance_cents).toBe("0");
    expect(body.report.operations).toMatchObject({ total: 0, failed: 0, rows: [] });
  });
});
