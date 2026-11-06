import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { verifyApiKey } from "@/server/auth/apiKeys";
import "@/server/contracts/tools";
import { findTool } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import type { Db } from "@/server/db/client";
import { agents } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { getAgentStatus, maskPayoutEmail, maskPayoutReceiver, registerAgent } from "@/server/services/agents";
import { ensureMainWorld } from "@/server/services/worlds";

describe("maskPayoutEmail", () => {
  it("keeps the first character and the domain, masking the rest of the local part", () => {
    expect(maskPayoutEmail("mandy@example.com")).toBe("m***@example.com");
  });
});

describe("maskPayoutReceiver", () => {
  it("masks an email like maskPayoutEmail and a PayPal payer ID to its first two characters", () => {
    expect(maskPayoutReceiver("mandy@example.com", "email")).toBe("m***@example.com");
    expect(maskPayoutReceiver("ABCDEFGHJK234", "paypal_id")).toBe("PAYPAL_ID:AB***");
  });
});

describe("registerAgent (service)", () => {
  let db: Db;
  let worldId: string;

  beforeEach(async () => {
    db = await createTestDb();
    process.env.API_KEY_PEPPER = "test-pepper";
    const world = await ensureMainWorld(db);
    worldId = world.worldId;
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("creates an ACTIVE agent and a key that verifies against it", async () => {
    const result = await registerAgent(db, worldId, {
      name: "Scout",
      payoutEmail: "scout@example.com",
    });

    expect(result.status).toBe("active");
    expect(result.apiKey).toMatch(/^mnd_[a-z2-7]{8}_[a-z2-7]{32}$/);

    const [row] = await db.select().from(agents).where(eq(agents.id, result.agentId));
    expect(row?.status).toBe("active");
    expect(row?.payoutReceiver).toBe("scout@example.com");

    const principal = await verifyApiKey(db, result.apiKey);
    expect(principal).not.toBeNull();
    expect(principal?.agentId).toBe(result.agentId);
    expect(principal?.status).toBe("active");
  });

  it("creates a brand-new agent on every call — no dedupe by name+payoutEmail", async () => {
    const first = await registerAgent(db, worldId, {
      name: "Scout",
      payoutEmail: "scout@example.com",
    });
    const second = await registerAgent(db, worldId, {
      name: "Scout",
      payoutEmail: "scout@example.com",
    });

    expect(first.agentId).not.toBe(second.agentId);
    expect(first.apiKey).not.toBe(second.apiKey);

    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.name, "Scout"), eq(agents.payoutReceiver, "scout@example.com")));
    expect(rows).toHaveLength(2);
  });
});

describe("getAgentStatus (service)", () => {
  it("reports zero balances, no open loan, and the fixed liquidity limits for a fresh agent", async () => {
    const db = await createTestDb();
    process.env.API_KEY_PEPPER = "test-pepper";
    const { worldId } = await ensureMainWorld(db);

    const { agentId } = await registerAgent(db, worldId, {
      name: "Scout",
      payoutEmail: "scout@example.com",
    });

    const status = await getAgentStatus(db, worldId, agentId);

    expect(status.agent.status).toBe("active");
    expect(status.agent.payoutEmailMasked).toBe("s***@example.com");
    expect(status.balances.notesCents).toBe(0n);
    expect(status.balances.payableToYouCents).toBe(0n);
    expect(status.openLoan).toBeNull();
    expect(status.limits.maxPrincipalCents).toBe(50000);
    expect(status.limits.availableLiquidityCents).toBe(10000n); // Ruling W: the bank's seed capital

    delete process.env.API_KEY_PEPPER;
  });
});

describe("register_agent / get_status tools (via runTool)", () => {
  beforeEach(() => {
    process.env.API_KEY_PEPPER = "test-pepper";
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("register_agent returns an ACTIVE agent, an api key, and the mcp block", async () => {
    const db = await createTestDb();
    const result = await runTool(
      findTool("register_agent"),
      "register_agent",
      { name: "Scout", payout_email: "scout@example.com" },
      { getDb: async () => db },
    );

    expect(result.httpStatus).toBe(200);
    expect(result.envelope.status).toBe("OK");
    const data = result.envelope.data as Record<string, unknown>;
    expect(data.status).toBe("ACTIVE");
    expect(data.world).toBe("main");
    expect(typeof data.agent_id).toBe("string");
    expect(typeof data.api_key).toBe("string");
    expect((data.mcp as Record<string, unknown>).header).toBe(
      `Authorization: Bearer ${data.api_key as string}`,
    );
    // P2: tier 0 — tell the human to claim first; lending is open.
    expect(data.tier).toBe(0);
    expect(result.envelope.next_actions.map((a) => a.tool)).toEqual([
      "human_approval",
      "get_status",
      "buy_notes",
    ]);
  });

  it("two register_agent calls with identical input create two distinct agents", async () => {
    const db = await createTestDb();
    const input = { name: "Scout", payout_email: "scout@example.com" };

    const first = await runTool(findTool("register_agent"), "register_agent", input, {
      getDb: async () => db,
    });
    const second = await runTool(findTool("register_agent"), "register_agent", input, {
      getDb: async () => db,
    });

    const firstId = (first.envelope.data as Record<string, unknown>).agent_id;
    const secondId = (second.envelope.data as Record<string, unknown>).agent_id;
    expect(firstId).not.toBe(secondId);

    const { worldId } = await ensureMainWorld(db);
    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.name, "Scout"), eq(agents.payoutReceiver, "scout@example.com")));
    expect(rows).toHaveLength(2);
    expect(worldId).toBeTruthy();
  });

  it("get_status, called with the key register_agent returned, reports zero balances", async () => {
    const db = await createTestDb();
    const registered = await runTool(
      findTool("register_agent"),
      "register_agent",
      { name: "Scout", payout_email: "scout@example.com" },
      { getDb: async () => db },
    );
    const apiKey = (registered.envelope.data as Record<string, unknown>).api_key as string;

    const result = await runTool(
      findTool("get_status"),
      "get_status",
      {},
      { getDb: async () => db, authorization: `Bearer ${apiKey}` },
    );

    expect(result.httpStatus).toBe(200);
    expect(result.envelope.status).toBe("OK");
    const data = result.envelope.data as Record<string, unknown>;
    expect((data.agent as Record<string, unknown>).status).toBe("ACTIVE");
    expect((data.agent as Record<string, unknown>).payout_email_masked).toBe(
      "s***@example.com",
    );
    expect((data.balances as Record<string, unknown>).notes_cents).toBe(0);
    expect((data.balances as Record<string, unknown>).payable_to_you_cents).toBe(0);
    expect(data.open_loan).toBeNull();
    expect((data.limits as Record<string, unknown>).max_principal_cents).toBe(50000);
    expect((data.limits as Record<string, unknown>).available_liquidity_cents).toBe(10000); // Ruling W seed
    expect(typeof data.sim_now).toBe("string");
    // P2: unclaimed (tier 0) — claim first, lending is open.
    expect(result.envelope.next_actions.map((a) => a.tool)).toEqual([
      "human_approval",
      "buy_notes",
    ]);
  });

  // Task 10 (real sandbox): a payout to a sandbox account's unconfirmed
  // email goes UNCLAIMED (RECEIVER_UNCONFIRMED) and is cancelled, so the
  // disbursement fails; the same account's payer ID receives it (SUCCESS).
  it("register_agent accepts payout_paypal_id instead of payout_email and stores a paypal_id receiver", async () => {
    const db = await createTestDb();
    const registered = await runTool(
      findTool("register_agent"),
      "register_agent",
      { name: "Scout", payout_paypal_id: "ABCDEFGHJK234" },
      { getDb: async () => db },
    );
    expect(registered.httpStatus).toBe(200);
    const data = registered.envelope.data as Record<string, unknown>;
    const [row] = await db.select().from(agents).where(eq(agents.id, data.agent_id as string));
    expect(row?.payoutReceiver).toBe("ABCDEFGHJK234");
    expect(row?.payoutReceiverType).toBe("paypal_id");

    const status = await runTool(
      findTool("get_status"),
      "get_status",
      {},
      { getDb: async () => db, authorization: `Bearer ${data.api_key as string}` },
    );
    expect(((status.envelope.data as Record<string, unknown>).agent as Record<string, unknown>).payout_email_masked).toBe(
      "PAYPAL_ID:AB***",
    );
  });

  it("register_agent rejects both or neither of payout_email / payout_paypal_id, and a malformed payer ID", async () => {
    const db = await createTestDb();
    for (const input of [
      { name: "Scout" },
      { name: "Scout", payout_email: "scout@example.com", payout_paypal_id: "ABCDEFGHJK234" },
      { name: "Scout", payout_paypal_id: "not-a-payer-id" },
    ]) {
      const result = await runTool(findTool("register_agent"), "register_agent", input, { getDb: async () => db });
      expect(result.httpStatus).toBe(400);
    }
    expect(await db.select().from(agents)).toHaveLength(0);
  });
});
