/**
 * P5 Task 3 — the daily AI treasury memo: once per world per sim day
 * (written by the tick after commit), the economy numbers only as input,
 * the LLM's text when valid, the template on any failure, and templates
 * only (no model call, no ai_runs row) in private worlds.
 */
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { treasuryOfficerInputSchema } from "@/server/ai/schemas";
import { treasuryOfficerTemplate } from "@/server/ai/templates";
import { advanceClock, getSimDay } from "@/server/clock/clock";
import type { Db } from "@/server/db/client";
import { aiRuns, economyState, principals } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { runTick } from "@/server/jobs/tick";
import { stepEconomyToNow } from "@/server/services/economy";
import { createPrivateWorld } from "@/server/services/privateWorlds";
import { treasuryMemoInput, writeDailyTreasuryMemo } from "@/server/services/treasuryMemo";

import { createSimWorld, fundPool } from "../../helpers/world";

const URL = "https://api.openai.com/v1/responses";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function replyWith(output: unknown) {
  let calls = 0;
  server.use(
    http.post(URL, () => {
      calls += 1;
      return HttpResponse.json({
        id: "resp_test",
        object: "response",
        created_at: 0,
        status: "completed",
        model: "test-model",
        output: [
          {
            type: "message",
            id: "msg_test",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: typeof output === "string" ? output : JSON.stringify(output), annotations: [] }],
          },
        ],
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 },
      });
    }),
  );
  return () => calls;
}

const GOOD = {
  headline: "Liquidity is comfortable and utilization is low.",
  observations: ["Cash comfortably exceeds the reserve floor."],
  risks: [],
};

async function memoRow(db: Db, worldId: string) {
  const { day } = await getSimDay(db, worldId);
  const [row] = await db
    .select()
    .from(economyState)
    .where(and(eq(economyState.worldId, worldId), eq(economyState.simDay, day))!);
  return row!;
}

async function memoRuns(db: Db, worldId: string) {
  return db
    .select()
    .from(aiRuns)
    .where(and(eq(aiRuns.worldId, worldId), eq(aiRuns.role, "treasury_officer"))!);
}

describe("daily treasury memo (P5 Task 3)", () => {
  let db: Db;
  let worldId: string;

  beforeEach(async () => {
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-a-real-key");
    vi.stubEnv("OPENAI_MODEL_UNDERWRITER", "test-underwriter");
    vi.stubEnv("OPENAI_DISABLED", "");
    db = await createTestDb();
    worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("the tick writes one memo per world per sim day from the LLM; later ticks that day don't call it again", async () => {
    const calls = replyWith(GOOD);
    const first = await runTick(db);
    expect(first.treasuryMemos).toBeGreaterThanOrEqual(1);
    const row = await memoRow(db, worldId);
    expect(row.treasuryMemo).toMatchObject({ ...GOOD, source: "ai", sim_day: row.simDay });
    expect(row.treasuryMemoAiRunId).toBeTruthy();
    const callsAfterFirst = calls();

    await runTick(db);
    await runTick(db);
    expect(calls()).toBe(callsAfterFirst);
    expect((await memoRuns(db, worldId)).length).toBe(1);
    expect(await writeDailyTreasuryMemo(db, worldId)).toEqual({ written: false, reason: "already_written" });

    // The next sim day gets its own memo.
    await advanceClock(db, worldId, 1);
    await runTick(db);
    expect((await memoRow(db, worldId)).treasuryMemo).toMatchObject({ source: "ai" });
    expect((await memoRuns(db, worldId)).length).toBe(2);
  });

  it("the input is the economy's numbers only (allowlisted integers, no identities)", async () => {
    await stepEconomyToNow(db, worldId);
    const { day } = await getSimDay(db, worldId);
    const input = (await treasuryMemoInput(db, worldId, day))!;
    expect(treasuryOfficerInputSchema.parse(input)).toEqual(input);
    for (const value of Object.values(input)) {
      expect(value === null || Number.isInteger(value)).toBe(true);
    }
    expect(input).toMatchObject({ simDay: day, baseRateBps: 400, queuedRedemptions: 0, notesPayableCents: 30000 });
  });

  it("an invalid LLM answer → the deterministic template (source fallback), still once", async () => {
    replyWith({ headline: "x", observations: "not a list" });
    await stepEconomyToNow(db, worldId);
    const result = await writeDailyTreasuryMemo(db, worldId);
    expect(result.written).toBe(true);
    const { day } = await getSimDay(db, worldId);
    const template = treasuryOfficerTemplate((await treasuryMemoInput(db, worldId, day))!);
    const row = await memoRow(db, worldId);
    expect(row.treasuryMemo).toMatchObject({ ...template, source: "fallback" });
    const [run] = await memoRuns(db, worldId);
    expect(run).toMatchObject({ fallbackUsed: true, errorCode: "schema_violation", subject: `treasury_memo:${day}` });
  });

  it("OpenAI disabled → template, logged as disabled", async () => {
    vi.stubEnv("OPENAI_DISABLED", "1");
    await stepEconomyToNow(db, worldId);
    await writeDailyTreasuryMemo(db, worldId);
    expect((await memoRow(db, worldId)).treasuryMemo).toMatchObject({ source: "fallback" });
    expect((await memoRuns(db, worldId))[0]).toMatchObject({ errorCode: "disabled" });
  });

  it("a fresh claim blocks a second writer; a stale claim without a memo can be taken again", async () => {
    replyWith(GOOD);
    await stepEconomyToNow(db, worldId);
    const row = await memoRow(db, worldId);
    await db.update(economyState).set({ treasuryMemoClaimedAt: new Date() }).where(eq(economyState.id, row.id));
    expect(await writeDailyTreasuryMemo(db, worldId)).toEqual({ written: false, reason: "claimed" });
    await db
      .update(economyState)
      .set({ treasuryMemoClaimedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(economyState.id, row.id));
    expect((await writeDailyTreasuryMemo(db, worldId)).written).toBe(true);
    // Concurrent writers: exactly one memo and one model run.
    await advanceClock(db, worldId, 1);
    await stepEconomyToNow(db, worldId);
    const results = await Promise.all([writeDailyTreasuryMemo(db, worldId), writeDailyTreasuryMemo(db, worldId)]);
    expect(results.filter((result) => result.written)).toHaveLength(1);
    expect((await memoRuns(db, worldId)).length).toBe(2);
  });

  it("no economy row for today → nothing written", async () => {
    expect(await writeDailyTreasuryMemo(db, worldId)).toEqual({ written: false, reason: "no_economy_row" });
  });

  it("private worlds use the template only: no model call, no ai_runs row", async () => {
    const calls = replyWith(GOOD);
    const [owner] = await db
      .insert(principals)
      .values({ paypalPayerId: "MEMO", email: "memo@example.com", name: "Memo", entityType: "individual", verifiedAt: new Date() })
      .returning();
    const created = await createPrivateWorld(db, owner!.id, { name: "Memo", seed: "memo-seed" });
    if (created.outcome !== "created") {
      throw new Error(`expected created, got ${created.outcome}`);
    }
    const privateId = created.worldId;
    await stepEconomyToNow(db, privateId);
    const result = await writeDailyTreasuryMemo(db, privateId);
    expect(result).toMatchObject({ written: true, aiRunId: null });
    const row = await memoRow(db, privateId);
    const { day } = await getSimDay(db, privateId);
    expect(row.treasuryMemo).toEqual({
      ...treasuryOfficerTemplate((await treasuryMemoInput(db, privateId, day))!),
      source: "template",
      sim_day: day,
    });
    expect(row.treasuryMemoAiRunId).toBeNull();
    expect(await memoRuns(db, privateId)).toHaveLength(0);
    expect(calls()).toBe(0);
  });
});
