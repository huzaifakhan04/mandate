import { connection, NextResponse } from "next/server";

import { getDb as defaultGetDb, type Db } from "@/server/db/client";
import { testLedgerReport } from "@/server/services/testLedger";
import { ensureMainWorldOnce } from "@/server/services/worlds";

/**
 * Whether the test-only endpoints are switched on: only with
 * `MANDATE_TEST_ENDPOINTS=1`, and never in a production build.
 */
export function testEndpointsEnabled(): boolean {
  return process.env.MANDATE_TEST_ENDPOINTS === "1" && process.env.NODE_ENV !== "production";
}

/**
 * Task 10 — `GET /api/test/ledger`: the main world's trial balance and
 * `paypal_operations` summary, for the real-sandbox end-to-end test
 * (tests/integration/core-loop.sandbox.test.ts), whose app server owns
 * its in-memory database. A plain 404 unless `testEndpointsEnabled()` —
 * it does not exist in a normal deployment.
 */
export function createTestLedgerHandler({ getDb }: { getDb: () => Promise<Db> }) {
  return {
    async GET(): Promise<NextResponse> {
      if (!testEndpointsEnabled()) {
        return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
      }
      const db = await getDb();
      const { worldId } = await ensureMainWorldOnce(db);
      return NextResponse.json({ ok: true, report: await testLedgerReport(db, worldId) });
    },
  };
}

const handler = createTestLedgerHandler({ getDb: defaultGetDb });

/** Always request-time (never prerendered at build), so the env gate is read per request. */
export async function GET(): Promise<NextResponse> {
  await connection();
  return handler.GET();
}
