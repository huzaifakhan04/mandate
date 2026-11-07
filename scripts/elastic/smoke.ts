/**
 * P7 Risk Desk — integration smoke against the REAL Elastic cluster.
 *
 *   npx tsx --env-file=.env.local scripts/elastic/smoke.ts [--keep]
 *
 * Uses an in-process PGlite bank (never Neon): creates a private world,
 * lets its bots run for 7 sim days, seeds human agents that trip every
 * detector (self-dealing, score farming, a sybil burst, limit probing,
 * redemption velocity), ships everything to Elastic (Jina embeddings at
 * ingest), runs all five ES|QL detectors, runs one investigation through
 * the real tool-calling loop (OpenAI + ES|QL + Jina semantic search with
 * the Jina reranker; `forceModel` because private worlds are template-only
 * in the app), and a console search. Deletes its documents afterwards
 * unless `--keep`. Prints counts, flags and the case file — never secrets.
 */
import { eq } from "drizzle-orm";

import { getSimNow } from "../../src/server/clock/clock";
import type { Db } from "../../src/server/db/client";
import {
  agents,
  applications,
  events,
  loans,
  noteSeries,
  notePositions,
  noteTransactions,
  offers,
  paypalOperations,
  principals,
  repaymentLinks,
  riskFlags,
} from "../../src/server/db/schema";
import { createTestDb } from "../../src/server/db/testing";
import { elasticClient } from "../../src/server/elastic/client";
import { ELASTIC_INDICES } from "../../src/server/elastic/config";
import { runDetectors } from "../../src/server/elastic/detectors";
import { ensureElasticIndices } from "../../src/server/elastic/mappings";
import { shipWorld } from "../../src/server/elastic/ship";
import { consoleSearch } from "../../src/server/services/consoleSearch";
import { advancePrivateWorld, createPrivateWorld } from "../../src/server/services/privateWorlds";
import { RISK_KINDS } from "../../src/server/services/riskFlags";
import { investigateFlag } from "../../src/server/services/riskInvestigation";

const HOUR = 3_600_000;
const OWNER_PAYER = "SMOKEOWNER7X1";

function log(line: string): void {
  console.log(line);
}

async function principal(db: Db, name: string, payerId: string | null) {
  const [row] = await db
    .insert(principals)
    .values({ email: `${name}@smoke.invalid`, name, entityType: "individual", verifiedAt: new Date(), kycStatus: "verified", paypalPayerId: payerId })
    .returning();
  return row!.id;
}

async function agent(db: Db, worldId: string, principalId: string, name: string, simAt: Date, createdAt = new Date()) {
  const [row] = await db
    .insert(agents)
    .values({ worldId, principalId, name, operator: "Smoke Ops", model: "smoke", codeManifestHash: "smoke", status: "active", claimedAt: createdAt, registeredSimAt: simAt, createdAt })
    .returning();
  return row!.id;
}

async function application(db: Db, worldId: string, agentId: string, amount: bigint, purpose: string, decision: "declined" | "approved", simAt: Date) {
  const [app] = await db
    .insert(applications)
    .values({
      worldId,
      agentId,
      amountCents: amount,
      termDays: 14,
      purpose,
      status: decision === "declined" ? "declined" : "offered",
      decision,
      reasonCodes: decision === "declined" ? ["amount_exceeds_limit"] : [],
      adverseAction: decision === "declined" ? { score: 55, grade: "C" } : null,
    })
    .returning();
  if (decision === "declined") {
    await db.insert(events).values({
      worldId,
      type: "loan.declined",
      aggregateType: "application",
      aggregateId: app!.id,
      payload: { reasons: ["amount_exceeds_limit"], score: 55, grade: "C" },
      occurredSimAt: simAt,
    });
  }
  return app!.id;
}

async function loan(db: Db, worldId: string, agentId: string, principalId: string, appId: string) {
  const [offer] = await db
    .insert(offers)
    .values({ worldId, applicationId: appId, principalCents: 2000n, feeCents: 40n, aprBps: 1500, termDays: 14, dueSimAt: new Date(), disclosureHash: "smoke", expiresSimAt: new Date() })
    .returning();
  const [row] = await db
    .insert(loans)
    .values({ worldId, offerId: offer!.id, agentId, principalId, principalCents: 2000n, feeCents: 40n, outstandingCents: 0n, dueSimAt: new Date(), status: "repaid" })
    .returning();
  return row!.id;
}

async function main(): Promise<void> {
  const client = elasticClient();
  if (!client) {
    throw new Error("ELASTIC_URL / ELASTIC_API_KEY are not set (run with --env-file=.env.local).");
  }
  const keep = process.argv.includes("--keep");
  const started = Date.now();
  await ensureElasticIndices(client);
  const db = await createTestDb();

  // --- a private world whose bots run for a week (bots must never be flagged) ---
  const owner = await principal(db, "smoke-owner", OWNER_PAYER);
  const created = await createPrivateWorld(db, owner, { name: "Risk Desk smoke", seed: "risk-desk-smoke" });
  if (created.outcome !== "created") throw new Error(`world: ${created.outcome}`);
  const worldId = created.worldId;
  await advancePrivateWorld(db, owner, worldId, 7);
  const simNow = await getSimNow(db, worldId);
  const at = (hoursAgo: number) => new Date(simNow.getTime() - hoursAgo * HOUR);
  log(`world ${worldId.slice(0, 8)}… (private, bots ran 7 sim days), sim now ${simNow.toISOString()}`);

  // --- self-dealing: an invoice link paid from the borrower's own human's PayPal account ---
  const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);
  const dealer = await agent(db, worldId, owner, "Self Dealer", at(48), hoursAgo(5));
  const dealerApp = await application(db, worldId, dealer, 2000n, "Working capital for a web design invoice", "approved", at(30));
  const dealerLoan = await loan(db, worldId, dealer, owner, dealerApp);
  const orderId = `SMOKE-ORDER-${worldId.slice(0, 8)}`;
  await db.insert(paypalOperations).values({
    worldId,
    rail: "sim",
    kind: "order.create",
    requestId: `smoke-${orderId}`,
    paypalId: orderId,
    status: "succeeded",
    purpose: "repayment_link",
    sourceId: dealerLoan,
    request: { body: { purchase_units: [{ amount: { currency_code: "USD", value: "30.00" } }] } },
    response: { orderId, status: "APPROVED" },
    simState: { orderId, status: "APPROVED", payer: { payerId: OWNER_PAYER, email: "x@smoke.invalid", givenName: "S", surname: "O" } },
  });
  await db.insert(repaymentLinks).values({ worldId, loanId: dealerLoan, kind: "invoice", amountCents: 3000n, paypalOrderId: orderId });

  // --- score farming: three borrow→repay cycles of a few hours each ---
  const farmer = await agent(db, worldId, owner, "Score Farmer", at(72), hoursAgo(4));
  for (const [i, start] of [20, 12, 6].entries()) {
    const appId = await application(db, worldId, farmer, 2000n, `Short-term float for API credits batch ${i + 1}`, "approved", at(start + 1));
    const loanId = await loan(db, worldId, farmer, owner, appId);
    await db.insert(events).values([
      { worldId, type: "loan.disbursed", aggregateType: "loan", aggregateId: loanId, payload: { principal_cents: 2000 }, occurredSimAt: at(start) },
      { worldId, type: "loan.repaid", aggregateType: "loan", aggregateId: loanId, payload: {}, occurredSimAt: at(start - 2) },
    ]);
  }

  // --- sybil burst: four agents from one human within ~9 real minutes ---
  const sybilHuman = await principal(db, "smoke-sybil", null);
  const now = new Date();
  for (const minutesAgo of [12, 9, 6, 3]) {
    await agent(db, worldId, sybilHuman, `Sybil ${minutesAgo}`, simNow, new Date(now.getTime() - minutesAgo * 60_000));
  }

  // --- probing: three declines stepping down, then a smaller ask within a sim day ---
  const prober = await agent(db, worldId, owner, "Limit Prober", at(96), hoursAgo(3));
  const steps: Array<[bigint, number]> = [[50000n, 6], [40000n, 5], [30000n, 4], [10000n, 3]];
  for (const [amount, hoursAgo] of steps) {
    await application(db, worldId, prober, amount, "GPU compute credits to fine-tune a customer support model", "declined", at(hoursAgo));
  }

  // --- velocity: five redemption requests today, none in the previous week ---
  const runner = await agent(db, worldId, owner, "Fast Redeemer", at(120), hoursAgo(2));
  const [series] = await db.select().from(noteSeries).where(eq(noteSeries.worldId, worldId)).limit(1);
  const [position] = await db
    .insert(notePositions)
    .values({ worldId, seriesId: series!.id, agentId: runner, units: 10000n, costCents: 10000n })
    .returning();
  for (let i = 0; i < 5; i += 1) {
    await db.insert(noteTransactions).values({ worldId, positionId: position!.id, kind: "redeem", amountCents: 500n, status: "pending" });
  }

  // --- ship everything (settle 0, refresh so the detectors see it) ---
  let shipped = 0;
  const byStream: Record<string, number> = {};
  for (let round = 0; round < 20; round += 1) {
    const report = await shipWorld(db, worldId, { now: new Date(), settleMs: 0, refresh: true });
    if (!report) throw new Error("shipping disabled");
    if (report.errors.length) throw new Error(`ship errors: ${report.errors.join("; ")}`);
    for (const [k, v] of Object.entries(report.shipped)) byStream[k] = (byStream[k] ?? 0) + (v ?? 0);
    shipped += report.total;
    if (report.total === 0) break;
  }
  log(`shipped ${shipped} docs: ${JSON.stringify(byStream)}`);

  // --- detectors ---
  const t0 = Date.now();
  const detected = await runDetectors(db, { worldId, simNow, now: new Date() });
  log(`detectors (${Date.now() - t0} ms): hits ${JSON.stringify(detected.hits)}, new flags ${detected.newFlagIds.length}, errors ${JSON.stringify(detected.errors)}`);
  const flags = await db.select().from(riskFlags).where(eq(riskFlags.worldId, worldId));
  const botIds = new Set((await db.select({ id: agents.id }).from(agents).where(eq(agents.isBot, true))).map((r) => r.id));
  const nameOf = new Map((await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.worldId, worldId))).map((r) => [r.id, r.name]));
  for (const flag of flags) {
    log(`  flag ${flag.kind.padEnd(13)} → ${nameOf.get(flag.agentId)}${botIds.has(flag.agentId) ? " (BOT!)" : ""}  evidence ${JSON.stringify(flag.evidence).slice(0, 160)}`);
  }
  const missing = RISK_KINDS.filter((kind) => !flags.some((f) => f.kind === kind));
  const botFlags = flags.filter((f) => botIds.has(f.agentId)).length;

  // --- one investigation through the real tool-calling loop ---
  const target = flags.find((f) => f.kind === "probing") ?? flags[0];
  if (target) {
    const t1 = Date.now();
    const outcome = await investigateFlag(db, worldId, target.id, { forceModel: true });
    const [row] = await db.select().from(riskFlags).where(eq(riskFlags.id, target.id));
    log(`investigation of ${target.kind} (${Date.now() - t1} ms): ${JSON.stringify(outcome)}`);
    log(`  case file: ${JSON.stringify(row?.caseFile, null, 2)}`);
  }

  // --- console search (semantic over purposes + keyword over events) ---
  const search = await consoleSearch(db, { id: worldId, name: "smoke", kind: "private", rail: "sim" }, "fine-tuning a model on rented GPUs");
  log(`console search: ${search.applications.length} applications, ${search.events.length} events, error ${search.error}`);
  for (const a of search.applications.slice(0, 3)) log(`  ${a.score} ${a.agent}: ${a.purpose} (${a.decision})`);
  const kw = await consoleSearch(db, { id: worldId, name: "smoke", kind: "private", rail: "sim" }, "loan.declined");
  log(`keyword search "loan.declined": ${kw.events.length} events`);

  if (!keep) {
    for (const index of Object.values(ELASTIC_INDICES)) {
      const result = await client.deleteByQuery({ index, query: { term: { world_id: worldId } }, refresh: true, conflicts: "proceed" });
      log(`cleanup ${index}: deleted ${result.deleted ?? 0}`);
    }
  }
  log(`done in ${Math.round((Date.now() - started) / 1000)} s — missing detectors: ${JSON.stringify(missing)}, bot flags: ${botFlags}`);
  if (missing.length > 0 || botFlags > 0) process.exit(2);
}

main().catch((err: unknown) => {
  const e = err as { name?: string; message?: string; meta?: { body?: { error?: { reason?: string } } } };
  console.error(`smoke failed: ${e?.name ?? "Error"}: ${(e?.meta?.body?.error?.reason ?? e?.message ?? "").split("\n")[0]}`);
  process.exit(1);
});
