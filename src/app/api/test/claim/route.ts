import { connection, NextResponse } from "next/server";

import { getDb as defaultGetDb, type Db } from "@/server/db/client";
import { claimAndMandateForTests } from "@/server/services/testClaim";
import { ensureMainWorldOnce } from "@/server/services/worlds";

import { testEndpointsEnabled } from "../ledger/route";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * TEST-ONLY — `POST /api/test/claim` `{ "agent_id": "<uuid>" }`: claims a
 * main-world agent for a fresh verified test principal and signs a
 * generous mandate (see `claimAndMandateForTests`), so the sandbox e2e and
 * the acceptance harness can borrow without a human in a browser. A plain
 * 404 unless `MANDATE_TEST_ENDPOINTS=1` outside production (the
 * `/api/test/ledger` gate). Task 7 replaces its callers with the real
 * Playwright claim + mandate flow.
 */
export function createTestClaimHandler({ getDb }: { getDb: () => Promise<Db> }) {
  return {
    async POST(request: Request): Promise<NextResponse> {
      if (!testEndpointsEnabled()) {
        return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
      }
      let agentId: unknown;
      try {
        agentId = ((await request.json()) as { agent_id?: unknown }).agent_id;
      } catch {
        agentId = undefined;
      }
      if (typeof agentId !== "string" || !UUID_RE.test(agentId)) {
        return NextResponse.json({ ok: false, error: "agent_id must be a uuid" }, { status: 400 });
      }
      const db = await getDb();
      const { worldId } = await ensureMainWorldOnce(db);
      try {
        const result = await claimAndMandateForTests(db, worldId, agentId);
        return NextResponse.json({ ok: true, principal_id: result.principalId, mandate_id: result.mandateId });
      } catch {
        return NextResponse.json({ ok: false, error: "no such main-world agent" }, { status: 404 });
      }
    },
  };
}

const handler = createTestClaimHandler({ getDb: defaultGetDb });

/** Always request-time, so the env gate is read per request. */
export async function POST(request: Request): Promise<NextResponse> {
  await connection();
  return handler.POST(request);
}
