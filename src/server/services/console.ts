import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { getSimDay, simDayIndex } from "../clock/clock";
import type { Db } from "../db/client";
import {
  agents,
  clock,
  creditScores,
  economyState,
  events,
  loans,
  notePositions,
  noteTransactions,
  offers,
  paypalOperations,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { utilizationBps } from "../domain/economy";
import { OPEN_LOAN_DB_STATUSES } from "../domain/loanMachine";
import { dailyMovements, latestJournalLines } from "../ledger/consoleLedger";
import { listOwnedPrivateWorlds, ownedPrivateWorld } from "./privateWorldAccess";
import type { StoredTreasuryMemo } from "./treasuryMemo";
import { ensureMainWorldOnce } from "./worlds";

/**
 * P6: the public bank console's read model ("mission control"). One call
 * builds everything `/console` shows for ONE world — the clock, the KPI
 * strip and its 30-day sparklines, the money-flow activity, the PayPal API
 * log and the four grids — as plain JSON (money as integer cents in JS
 * numbers; every world's balances are far below 2^53).
 *
 * It is PUBLIC, so it never carries PII: no principal rows at all, no
 * emails, payer ids or payout receivers, no PayPal request/response
 * bodies, no journal memos or event payloads. PayPal ids are truncated.
 * Free text that is shown (agent names, operator) goes through
 * `scrubText`, which masks anything that looks like an email.
 *
 * Who may see which world is decided by `resolveConsoleWorld`: the main
 * world for everyone; a private world only for its signed-in owner.
 */

const DAY_MS = 86_400_000;

export const CONSOLE_SERIES_DAYS = 30;
export const CONSOLE_LOG_LIMIT = 50;
export const CONSOLE_ACTIVITY_LIMIT = 24;
export const CONSOLE_LEDGER_ENTRIES = 150;
export const CONSOLE_GRID_LIMIT = 500;

export type FlowEdge = "lend" | "disburse" | "invoice" | "client_pay" | "repay" | "redeem";

export interface ConsoleWorld {
  id: string;
  name: string;
  kind: "main" | "private";
  rail: "paypal" | "sim";
}

export interface ConsoleSnapshot {
  generatedAt: string;
  world: ConsoleWorld;
  clock: { simNow: string; simDay: number; speed: number };
  kpis: {
    cashCents: number;
    loansOutstandingCents: number;
    notesOutstandingCents: number;
    utilizationBps: number;
    baseRateBps: number;
    inflationRateBps: number;
    reserveRatioBps: number;
    /** The CECL allowance — gross of note-holder loss sharing. */
    allowanceCents: number;
    /** Loans ever charged off (charged_off + recovered). */
    defaults: number;
    loansTotal: number;
    memo: { simDay: number; headline: string; source: string } | null;
  };
  /** Up to the last 30 sim days, oldest first. */
  series: Array<{
    day: number;
    cashCents: number;
    loansCents: number;
    notesCents: number;
    utilizationBps: number;
    baseRateBps: number;
    inflationRateBps: number;
    reserveRatioBps: number;
    allowanceCents: number;
    defaults: number;
  }>;
  flow: {
    lenders: Array<{ name: string; notesCents: number }>;
    borrowers: Array<{ name: string; grade: string | null; status: string; principalCents: number }>;
    lenderCount: number;
    borrowerCount: number;
    /** Newest first. `key` is stable per underlying row, so a client can spot new ones. */
    activity: Array<{ key: string; edge: FlowEdge; label: string; at: string }>;
  };
  paypalLog: Array<{
    id: string;
    at: string;
    rail: string;
    kind: string;
    purpose: string | null;
    status: string;
    httpStatus: number | null;
    latencyMs: number | null;
    amountCents: number | null;
    paypalId: string | null;
  }>;
  ledger: Array<{
    id: string;
    entry: string;
    day: number;
    simAt: string;
    source: string;
    account: string;
    owner: string | null;
    debitCents: number | null;
    creditCents: number | null;
  }>;
  ledgerEntries: number;
  loans: Array<{
    id: string;
    loan: string;
    agent: string;
    status: string;
    grade: string | null;
    principalCents: number;
    feeCents: number;
    aprBps: number | null;
    outstandingCents: number;
    dueSimAt: string;
    daysLate: number;
  }>;
  notes: Array<{
    id: string;
    holder: string;
    units: number;
    costCents: number;
    earnedCents: number;
    queuedRedemptions: number;
    queuedCents: number;
    pendingRedemptions: number;
    status: string;
  }>;
  agents: Array<{
    id: string;
    name: string;
    role: string;
    tier: number;
    score: number | null;
    grade: string | null;
    status: string;
    bot: boolean;
  }>;
}

const EMAIL_RE = /[^\s@]+@[^\s@]+/g;

/** Masks anything that looks like an email in free text shown on the public console. */
export function scrubText(value: string): string {
  return value.replace(EMAIL_RE, "[redacted]");
}

/** A PayPal id cut to its first 4 and last 2 characters (`8RD4…K2`). */
export function truncateId(id: string | null): string | null {
  if (!id) {
    return null;
  }
  return id.length <= 8 ? `${id.slice(0, 2)}…` : `${id.slice(0, 4)}…${id.slice(-2)}`;
}

/** A short display label from a uuid, e.g. `L-3F9A1C`. */
export function shortLabel(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

/**
 * The first money amount in a (redacted) PayPal request body — an order's
 * `purchase_units[].amount` or a payout item's `amount` — as cents, or
 * `null`. Only the number leaves this function.
 */
export function requestAmountCents(request: unknown): number | null {
  const seen = new Set<unknown>();
  function walk(node: unknown, depth: number): number | null {
    if (!node || typeof node !== "object" || depth > 6 || seen.has(node)) {
      return null;
    }
    seen.add(node);
    const record = node as Record<string, unknown>;
    const amount = record.amount;
    if (amount && typeof amount === "object") {
      const value = (amount as Record<string, unknown>).value;
      if (typeof value === "string" && /^\d+(\.\d{1,2})?$/.test(value)) {
        const [whole, frac = ""] = value.split(".");
        return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
      }
    }
    for (const child of Object.values(record)) {
      const found = walk(child, depth + 1);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  return walk(request, 0);
}

const PURPOSE_EDGE: Record<string, FlowEdge> = {
  note_purchase_capture: "lend",
  loan_disbursement: "disburse",
  repayment_link: "invoice",
  repayment_capture: "client_pay",
  repayment_direct: "repay",
  note_redemption: "redeem",
  remainder_payout: "disburse",
};

const EVENT_EDGE: Record<string, { edge: FlowEdge; label: string }> = {
  "loan.disbursed": { edge: "disburse", label: "loan disbursed" },
  "loan.repayment_received": { edge: "client_pay", label: "repayment received" },
  "loan.recovery_received": { edge: "repay", label: "recovery received" },
  "loan.repaid": { edge: "repay", label: "loan repaid" },
};

const EDGE_LABEL: Record<FlowEdge, string> = {
  lend: "note purchase",
  disburse: "payout to borrower",
  invoice: "invoice sent to client",
  client_pay: "client paid invoice",
  repay: "borrower repaid",
  redeem: "note redemption",
};

const num = (value: bigint | null | undefined): number => Number(value ?? 0n);

/**
 * Which world the console shows: `requested` when it names one of the
 * signed-in principal's active private worlds; the main world when nothing
 * (or `main`) is asked for. Anything else — someone else's world, an
 * archived one, another main-kind world, a malformed id, or any private
 * world without a session — is `null` (the caller answers 404).
 */
export async function resolveConsoleWorld(
  db: Db,
  principalId: string | null,
  requested: string | null | undefined,
): Promise<ConsoleWorld | null> {
  if (!requested || requested === "main") {
    const { worldId } = await ensureMainWorldOnce(db);
    return { id: worldId, name: "Main", kind: "main", rail: "paypal" };
  }
  if (!principalId) {
    return null;
  }
  const world = await ownedPrivateWorld(db, principalId, requested);
  if (!world) {
    return null;
  }
  return { id: world.id, name: scrubText(world.name), kind: "private", rail: world.railMode === "paypal" ? "paypal" : "sim" };
}

export async function consoleSnapshot(db: Db, world: ConsoleWorld, realNow: Date = new Date()): Promise<ConsoleSnapshot> {
  const w = scoped(db, world.id);
  const [clockRow] = await w.select(clock);
  const { simNow, anchorSim, day: simDay } = await getSimDay(db, world.id, realNow);

  // --- agents, scores ---
  const agentRows = await w.selectFields(agents, {
    id: agents.id,
    name: agents.name,
    kyaTier: agents.kyaTier,
    status: agents.status,
    isBot: agents.isBot,
    principalId: agents.principalId,
  });
  const nameOf = new Map(agentRows.map((a) => [a.id, scrubText(a.name)]));
  const scores = await w.selectFields(creditScores, {
    subjectId: creditScores.subjectId,
    score: creditScores.score,
    grade: creditScores.grade,
    subjectType: creditScores.subjectType,
  });
  const scoreOf = new Map(scores.filter((s) => s.subjectType === "agent").map((s) => [s.subjectId, s]));

  // --- loans ---
  const loanRows = await w.select(loans);
  const offerRows = loanRows.length
    ? await w.selectFields(
        offers,
        { id: offers.id, aprBps: offers.aprBps },
        inArray(
          offers.id,
          loanRows.map((l) => l.offerId),
        ),
      )
    : [];
  const aprOf = new Map(offerRows.map((o) => [o.id, o.aprBps]));
  const owingStatuses = new Set<string>(["active", "late", "substandard"]);
  const loansView = loanRows
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, CONSOLE_GRID_LIMIT)
    .map((loan) => {
      const late =
        owingStatuses.has(loan.status) || loan.status === "charged_off"
          ? Math.max(0, Math.floor((simNow.getTime() - loan.dueSimAt.getTime()) / DAY_MS))
          : 0;
      return {
        id: loan.id,
        loan: shortLabel("L", loan.id),
        agent: nameOf.get(loan.agentId) ?? "—",
        status: loan.status,
        grade: loan.riskGrade,
        principalCents: num(loan.principalCents),
        feeCents: num(loan.feeCents),
        aprBps: aprOf.get(loan.offerId) ?? null,
        outstandingCents: owingStatuses.has(loan.status) ? num(loan.outstandingCents) : 0,
        dueSimAt: loan.dueSimAt.toISOString(),
        daysLate: late,
      };
    });
  const defaultsCount = loanRows.filter((l) => l.status === "charged_off" || l.status === "recovered").length;

  // --- notes ---
  const positions = await w.select(notePositions);
  const redemptions = positions.length
    ? await w.selectFields(
        noteTransactions,
        { positionId: noteTransactions.positionId, status: noteTransactions.status, amountCents: noteTransactions.amountCents },
        and(eq(noteTransactions.kind, "redeem"), inArray(noteTransactions.status, ["queued", "pending"]))!,
      )
    : [];
  const notesView = positions
    .map((p) => {
      const mine = redemptions.filter((r) => r.positionId === p.id);
      const queued = mine.filter((r) => r.status === "queued");
      return {
        id: p.id,
        holder: nameOf.get(p.agentId) ?? "—",
        units: num(p.units),
        costCents: num(p.costCents),
        earnedCents: num(p.accruedCents),
        queuedRedemptions: queued.length,
        queuedCents: queued.reduce((s, r) => s + num(r.amountCents), 0),
        pendingRedemptions: mine.length - queued.length,
        status: p.status,
      };
    })
    .sort((a, b) => b.units - a.units)
    .slice(0, CONSOLE_GRID_LIMIT);

  // --- agents grid ---
  const lenderIds = new Set(positions.filter((p) => p.units > 0n).map((p) => p.agentId));
  const borrowerIds = new Set(loanRows.map((l) => l.agentId));
  const agentsView = agentRows
    .map((a) => {
      const s = scoreOf.get(a.id);
      const roles = [lenderIds.has(a.id) ? "lender" : null, borrowerIds.has(a.id) ? "borrower" : null].filter(Boolean);
      return {
        id: a.id,
        name: scrubText(a.name),
        role: roles.length ? roles.join(" + ") : "—",
        tier: a.kyaTier,
        score: s?.score ?? null,
        grade: s?.grade ?? null,
        status: a.status,
        bot: a.isBot,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, CONSOLE_GRID_LIMIT);

  // --- ledger (latest entries, one row per posting) ---
  const { entries, entryCount, lines: entryPostings } = await latestJournalLines(db, world.id, CONSOLE_LEDGER_ENTRIES);
  const ledgerView: ConsoleSnapshot["ledger"] = [];
  for (const entry of entries) {
    const lines = entryPostings
      .filter((p) => p.entryId === entry.id)
      .sort((a, b) => (a.amountCents > 0n === b.amountCents > 0n ? 0 : a.amountCents > 0n ? -1 : 1));
    for (const line of lines) {
      ledgerView.push({
        id: line.id,
        entry: shortLabel("JE", entry.id),
        day: simDayIndex(anchorSim, entry.simAt),
        simAt: entry.simAt.toISOString(),
        source: entry.sourceType,
        account: line.code,
        owner: line.ownerRef ? (nameOf.get(line.ownerRef) ?? "—") : null,
        debitCents: line.amountCents > 0n ? num(line.amountCents) : null,
        creditCents: line.amountCents < 0n ? num(-line.amountCents) : null,
      });
    }
  }

  // --- PayPal log ---
  const ops = await w.selectFields(
    paypalOperations,
    {
      id: paypalOperations.id,
      createdAt: paypalOperations.createdAt,
      updatedAt: paypalOperations.updatedAt,
      rail: paypalOperations.rail,
      kind: paypalOperations.kind,
      purpose: paypalOperations.purpose,
      status: paypalOperations.status,
      httpStatus: paypalOperations.httpStatus,
      latencyMs: paypalOperations.latencyMs,
      paypalId: paypalOperations.paypalId,
      request: paypalOperations.request,
    },
    undefined,
    desc(paypalOperations.createdAt),
    CONSOLE_LOG_LIMIT,
  );
  const paypalLog = ops.map((op) => ({
    id: op.id,
    at: op.createdAt.toISOString(),
    rail: op.rail,
    kind: op.kind,
    purpose: op.purpose,
    status: op.status,
    httpStatus: op.httpStatus,
    latencyMs: op.latencyMs,
    amountCents: requestAmountCents(op.request),
    paypalId: truncateId(op.paypalId),
  }));

  // --- flow activity: succeeded money operations + loan events ---
  const activity: ConsoleSnapshot["flow"]["activity"] = [];
  for (const op of ops) {
    const edge = op.purpose ? PURPOSE_EDGE[op.purpose] : undefined;
    if (!edge || op.status !== "succeeded") {
      continue;
    }
    if (op.purpose === "repayment_link" && op.kind !== "order.create") {
      continue;
    }
    const amount = requestAmountCents(op.request);
    activity.push({
      key: `op:${op.id}`,
      edge,
      label: amount !== null ? `${EDGE_LABEL[edge]} · $${(amount / 100).toFixed(2)}` : EDGE_LABEL[edge],
      at: op.updatedAt.toISOString(),
    });
  }
  const recentEvents = await w.selectFields(
    events,
    { id: events.id, type: events.type, createdAt: events.createdAt },
    inArray(events.type, Object.keys(EVENT_EDGE)),
    desc(events.seq),
    CONSOLE_ACTIVITY_LIMIT,
  );
  for (const event of recentEvents) {
    const mapped = EVENT_EDGE[event.type]!;
    activity.push({ key: `ev:${event.id}`, edge: mapped.edge, label: mapped.label, at: event.createdAt.toISOString() });
  }
  activity.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  // --- flow nodes ---
  const notesBy = new Map<string, bigint>();
  for (const p of positions) {
    notesBy.set(p.agentId, (notesBy.get(p.agentId) ?? 0n) + p.units);
  }
  const lenders = [...notesBy.entries()]
    .filter(([, units]) => units > 0n)
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .map(([id, units]) => ({ name: nameOf.get(id) ?? "—", notesCents: num(units) }));
  const openLoans = loanRows.filter((l) => (OPEN_LOAN_DB_STATUSES as readonly string[]).includes(l.status));
  const borrowers = openLoans
    .slice()
    .sort((a, b) => (b.principalCents > a.principalCents ? 1 : b.principalCents < a.principalCents ? -1 : 0))
    .map((l) => ({
      name: nameOf.get(l.agentId) ?? "—",
      grade: l.riskGrade,
      status: l.status,
      principalCents: num(l.principalCents),
    }));

  // --- KPIs + 30-day series: ONE bounded ledger query. Each code's rows
  // are its balance before the window (bucket firstDay - 1) plus one row
  // per day inside it, so the live balance is the sum of its rows. ---
  const lastDay = Math.max(0, simDay);
  const firstDay = Math.max(0, lastDay - CONSOLE_SERIES_DAYS + 1);
  const movements = await dailyMovements(db, world.id, anchorSim, firstDay);
  const balanceThrough = (code: string, day: number) =>
    movements.filter((m) => m.code === code && m.day <= day).reduce((s, m) => s + m.total, 0n);
  const balanceNow = (code: string) => movements.filter((m) => m.code === code).reduce((s, m) => s + m.total, 0n);
  const cashNow = balanceNow("cash_paypal");
  const loansNow = balanceNow("loans_receivable");
  const notesOutstanding = -balanceNow("notes_payable");
  const allowance = -balanceNow("allowance_for_losses");
  const utilizationNow = utilizationBps(cashNow, loansNow);
  const latest = await w.findLatest(economyState, eq(economyState.worldId, world.id), economyState.simDay);
  const memoRow = await w.findLatest(economyState, isNotNull(economyState.treasuryMemo), economyState.simDay);
  const memo = (memoRow?.treasuryMemo as StoredTreasuryMemo | null | undefined) ?? null;
  const reserveRatioBps =
    notesOutstanding > 0n ? Number((cashNow * 10_000n) / notesOutstanding) : (latest?.reserveRatioBps ?? 0);

  const econRows = (
    await w.select(economyState, sql`${economyState.simDay} >= ${firstDay}`)
  ).sort((a, b) => a.simDay - b.simDay);
  const econByDay = new Map(econRows.map((r) => [r.simDay, r]));
  const chargeOffDays = loanRows
    .filter((l) => l.chargedOffAt)
    .map((l) => simDayIndex(anchorSim, l.chargedOffAt!));
  const series: ConsoleSnapshot["series"] = [];
  let lastEcon = econRows.find((r) => r.simDay <= firstDay);
  for (let day = firstDay; day <= lastDay; day += 1) {
    lastEcon = econByDay.get(day) ?? lastEcon;
    const cash = balanceThrough("cash_paypal", day);
    const loansCents = balanceThrough("loans_receivable", day);
    series.push({
      day,
      cashCents: num(cash),
      loansCents: num(loansCents),
      notesCents: num(-balanceThrough("notes_payable", day)),
      utilizationBps: lastEcon?.utilizationBps ?? 0,
      baseRateBps: lastEcon?.baseRateBps ?? 0,
      inflationRateBps: lastEcon?.inflationRateBps ?? 0,
      reserveRatioBps: lastEcon?.reserveRatioBps ?? 0,
      allowanceCents: num(-balanceThrough("allowance_for_losses", day)),
      defaults: chargeOffDays.filter((d) => d <= day).length,
    });
  }

  return {
    generatedAt: realNow.toISOString(),
    world,
    clock: { simNow: simNow.toISOString(), simDay, speed: Number(clockRow?.speed ?? 0) },
    kpis: {
      cashCents: num(cashNow),
      loansOutstandingCents: num(loansNow),
      notesOutstandingCents: num(notesOutstanding),
      utilizationBps: utilizationNow,
      baseRateBps: latest?.baseRateBps ?? 0,
      inflationRateBps: latest?.inflationRateBps ?? 0,
      reserveRatioBps,
      allowanceCents: num(allowance),
      defaults: defaultsCount,
      loansTotal: loanRows.length,
      memo: memo ? { simDay: memo.sim_day, headline: scrubText(memo.headline), source: memo.source } : null,
    },
    series,
    flow: {
      lenders: lenders.slice(0, 3),
      borrowers: borrowers.slice(0, 3),
      lenderCount: lenders.length,
      borrowerCount: borrowers.length,
      activity: activity.slice(0, CONSOLE_ACTIVITY_LIMIT),
    },
    paypalLog,
    ledger: ledgerView,
    ledgerEntries: entryCount,
    loans: loansView,
    notes: notesView,
    agents: agentsView,
  };
}

/** Worlds the switcher offers: main, plus the principal's active private worlds. */
export async function consoleWorldChoices(
  db: Db,
  principalId: string | null,
): Promise<Array<{ id: string; name: string; kind: "main" | "private" }>> {
  const choices: Array<{ id: string; name: string; kind: "main" | "private" }> = [{ id: "main", name: "Main world", kind: "main" }];
  if (!principalId) {
    return choices;
  }
  const rows = await listOwnedPrivateWorlds(db, principalId);
  return [...choices, ...rows.map((r) => ({ id: r.id, name: scrubText(r.name), kind: "private" as const }))];
}

/**
 * P6 review: a per-world, in-process snapshot cache in front of
 * `consoleSnapshot`. Each entry is fresh for `SNAPSHOT_CACHE_TTL_MS` after
 * its computation settles, and single-flight: concurrent callers for the
 * same key share the one in-flight computation. The key is the world plus
 * the view — a private world's (owner-only) view is never stored under the
 * public key, so an anonymous caller can never be handed it. Keyed per
 * `Db` instance (a WeakMap, so test databases don't share entries). A
 * failed computation is evicted at once. `invalidateConsoleSnapshot` drops
 * a world's entries after an owner action (clock advance, stress, reset).
 */
export const SNAPSHOT_CACHE_TTL_MS = 900; // 2s poll + 0.9s cache keeps worst-case staleness under the 3s real-time target
const SNAPSHOT_CACHE_MAX_KEYS = 500;

interface CacheEntry {
  promise: Promise<ConsoleSnapshot>;
  /** When the computation settled; `null` while in flight. */
  settledAtMs: number | null;
}

const snapshotCaches = new WeakMap<Db, Map<string, CacheEntry>>();
const invalidatedWorlds = new Set<string>();

function cacheKey(world: ConsoleWorld): string {
  return `${world.id}:${world.kind === "private" ? "owner" : "public"}`;
}

export function cachedConsoleSnapshot(db: Db, world: ConsoleWorld, nowMs: () => number = Date.now): Promise<ConsoleSnapshot> {
  let cache = snapshotCaches.get(db);
  if (!cache) {
    cache = new Map();
    snapshotCaches.set(db, cache);
  }
  const key = cacheKey(world);
  if (invalidatedWorlds.delete(world.id)) {
    for (const k of [...cache.keys()]) {
      if (k.startsWith(`${world.id}:`)) {
        cache.delete(k);
      }
    }
  }
  const hit = cache.get(key);
  if (hit && (hit.settledAtMs === null || nowMs() - hit.settledAtMs < SNAPSHOT_CACHE_TTL_MS)) {
    return hit.promise;
  }
  const entry: CacheEntry = { promise: Promise.resolve() as unknown as Promise<ConsoleSnapshot>, settledAtMs: null };
  entry.promise = consoleSnapshot(db, world, new Date(nowMs())).then(
    (snapshot) => {
      entry.settledAtMs = nowMs();
      return snapshot;
    },
    (err: unknown) => {
      if (cache!.get(key) === entry) {
        cache!.delete(key);
      }
      throw err;
    },
  );
  cache.set(key, entry);
  if (cache.size > SNAPSHOT_CACHE_MAX_KEYS) {
    for (const [k, e] of cache) {
      if (cache.size <= SNAPSHOT_CACHE_MAX_KEYS) {
        break;
      }
      if (e.settledAtMs !== null) {
        cache.delete(k);
      }
    }
  }
  return entry.promise;
}

/** Drops a world's cached snapshots (every `Db`) — the next read recomputes. */
export function invalidateConsoleSnapshot(worldId: string): void {
  invalidatedWorlds.add(worldId);
}
