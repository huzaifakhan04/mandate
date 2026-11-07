import { and, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { simNow as simNowFor } from "../clock/clock";
import type { Db } from "../db/client";
import {
  agents,
  applications,
  clock,
  elasticCursors,
  events,
  loans,
  mandates,
  notePositions,
  noteTransactions,
  offers,
  paypalOperations,
  principals,
  repaymentLinks,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { requestAmountCents } from "../services/console";
import { elasticClient, elasticErrorMessage } from "./client";
import { ELASTIC_INDICES, hashId, SHIP_BATCH_PER_WORLD } from "./config";
import {
  type AgentInfo,
  agentRegisteredDoc,
  applicationDoc,
  eventDoc,
  noteRedemptionDoc,
  payerIdOf,
  paypalOpDoc,
} from "./docs";

/**
 * P7 Task 1 — the Elastic outbox. Each tick, for each world, new rows are
 * shipped in `(timestamp, id)` order to the Risk Desk indices, at most
 * `SHIP_BATCH_PER_WORLD` (500) documents per world per tick across all
 * streams:
 *
 *   agents            → mandate-events (`agent.registered`)
 *   events            → mandate-events (the events table)
 *   applications      → mandate-applications (purpose as Jina semantic_text)
 *   note_redemptions  → mandate-events (`note.redemption_requested`)
 *   paypal_ops        → mandate-paypal-ops (by `updated_at`: status changes re-ship the op)
 *
 * The watermark (`elastic_cursors`) is advanced only past documents
 * Elastic accepted; a failed bulk leaves it where it was, so the next tick
 * retries (documents have stable `_id`s, so a re-ship overwrites). Rows
 * younger than `settleMs` wait a tick, so a transaction that committed late
 * with an earlier `created_at` is not skipped. Timestamps are compared at
 * millisecond precision (what a JS `Date` holds).
 *
 * An after-commit module: a plain `db`, never a transaction (Elastic is
 * never called inside one — tests/unit/elastic/noTransactionCalls.test.ts).
 */

export const SHIP_STREAMS = ["agents", "events", "applications", "note_redemptions", "paypal_ops"] as const;
export type ShipStream = (typeof SHIP_STREAMS)[number];

/** Rows younger than this wait for the next tick (late-committing transactions). */
export const SHIP_SETTLE_MS = 30_000;

export interface ShipReport {
  worldId: string;
  shipped: Partial<Record<ShipStream, number>>;
  total: number;
  errors: string[];
}

interface Cursor {
  at: Date | null;
  id: string | null;
}

interface Pending {
  id: string;
  at: Date;
  index: string;
  docId: string;
  doc: Record<string, unknown>;
}

/** `(date_trunc('milliseconds', ts), id) > (cursor)` — the rows after the watermark. */
function after(ts: AnyPgColumn, id: AnyPgColumn, cursor: Cursor): SQL | undefined {
  if (!cursor.at || !cursor.id) {
    return undefined;
  }
  return sql`(date_trunc('milliseconds', ${ts}), ${id}) > (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
}

function order(ts: AnyPgColumn, id: AnyPgColumn): SQL {
  return sql`date_trunc('milliseconds', ${ts}), ${id}`;
}

export async function readCursor(db: Db, worldId: string, stream: string): Promise<Cursor> {
  const row = await scoped(db, worldId).findOne(elasticCursors, eq(elasticCursors.stream, stream));
  return { at: row?.cursorAt ?? null, id: row?.cursorId ?? null };
}

export async function writeCursor(
  db: Db,
  worldId: string,
  stream: string,
  values: { at?: Date | null; id?: string | null; shippedDelta?: number; lastError?: string | null },
): Promise<void> {
  const world = scoped(db, worldId);
  await world.insertOnConflictDoNothing(elasticCursors, { stream }, [elasticCursors.worldId, elasticCursors.stream]);
  const set: Record<string, unknown> = {};
  if (values.at !== undefined) set.cursorAt = values.at;
  if (values.id !== undefined) set.cursorId = values.id;
  if (values.shippedDelta) set.shipped = sql`${elasticCursors.shipped} + ${values.shippedDelta}`;
  if (values.lastError !== undefined) set.lastError = values.lastError;
  await scoped(db, worldId).update(elasticCursors, set, eq(elasticCursors.stream, stream));
}

/** Each agent's hashed principal and bot flag. */
async function agentInfos(db: Db, worldId: string, agentIds: Iterable<string>): Promise<Map<string, AgentInfo>> {
  const ids = [...new Set([...agentIds].filter(Boolean))];
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await scoped(db, worldId).selectFields(
    agents,
    { id: agents.id, principalId: agents.principalId, isBot: agents.isBot },
    inArray(agents.id, ids),
  );
  return new Map(rows.map((r) => [r.id, { principalHash: hashId(r.principalId), isBot: r.isBot }]));
}

async function clockFor(db: Db, worldId: string): Promise<(real: Date) => Date> {
  const row = await scoped(db, worldId).findOne(clock, eq(clock.worldId, worldId));
  if (!row) {
    return (real) => real;
  }
  const state = { anchorReal: row.anchorReal, anchorSim: row.anchorSim, speed: Number(row.speed), manualOffsetMs: row.manualOffsetMs };
  return (real) => simNowFor(state, real);
}

// ----------------------------------------------------------------- streams

type Collector = (db: Db, worldId: string, cursor: Cursor, limit: number, settledBefore: Date) => Promise<Pending[]>;

const collectAgents: Collector = async (db, worldId, cursor, limit, settledBefore) => {
  const rows = await scoped(db, worldId).selectFields(
    agents,
    { id: agents.id, principalId: agents.principalId, isBot: agents.isBot, registeredSimAt: agents.registeredSimAt, createdAt: agents.createdAt },
    and(lt(agents.createdAt, settledBefore), after(agents.createdAt, agents.id, cursor)),
    order(agents.createdAt, agents.id),
    limit,
  );
  const toSim = await clockFor(db, worldId);
  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt,
    index: ELASTIC_INDICES.events,
    docId: `agent:${r.id}`,
    doc: agentRegisteredDoc({
      id: r.id,
      worldId,
      principalId: r.principalId,
      isBot: r.isBot,
      simAt: r.registeredSimAt ?? toSim(r.createdAt),
      createdAt: r.createdAt,
    }),
  }));
};

const collectEvents: Collector = async (db, worldId, cursor, limit, settledBefore) => {
  const world = scoped(db, worldId);
  const rows = await world.selectFields(
    events,
    {
      id: events.id,
      seq: events.seq,
      type: events.type,
      aggregateType: events.aggregateType,
      aggregateId: events.aggregateId,
      payload: events.payload,
      occurredSimAt: events.occurredSimAt,
      createdAt: events.createdAt,
    },
    and(lt(events.createdAt, settledBefore), after(events.createdAt, events.id, cursor)),
    order(events.createdAt, events.id),
    limit,
  );
  const idsOf = (type: string) => rows.filter((r) => r.aggregateType === type).map((r) => r.aggregateId);
  const agentOf = new Map<string, string>();
  for (const id of idsOf("agent")) agentOf.set(id, id);
  const loanIds = idsOf("loan");
  if (loanIds.length) {
    for (const r of await world.selectFields(loans, { id: loans.id, agentId: loans.agentId }, inArray(loans.id, loanIds))) {
      agentOf.set(r.id, r.agentId);
    }
  }
  const mandateIds = idsOf("mandate");
  if (mandateIds.length) {
    for (const r of await world.selectFields(mandates, { id: mandates.id, agentId: mandates.agentId }, inArray(mandates.id, mandateIds))) {
      agentOf.set(r.id, r.agentId);
    }
  }
  const offerIds = idsOf("offer");
  const appIds = new Set(idsOf("application"));
  const offerApp = new Map<string, string>();
  if (offerIds.length) {
    for (const r of await world.selectFields(offers, { id: offers.id, applicationId: offers.applicationId }, inArray(offers.id, offerIds))) {
      offerApp.set(r.id, r.applicationId);
      appIds.add(r.applicationId);
    }
  }
  if (appIds.size) {
    const apps = await world.selectFields(applications, { id: applications.id, agentId: applications.agentId }, inArray(applications.id, [...appIds]));
    const appAgent = new Map(apps.map((a) => [a.id, a.agentId]));
    for (const id of appIds) {
      const agentId = appAgent.get(id);
      if (agentId) agentOf.set(id, agentId);
    }
    for (const [offerId, appId] of offerApp) {
      const agentId = appAgent.get(appId);
      if (agentId) agentOf.set(offerId, agentId);
    }
  }
  const infos = await agentInfos(db, worldId, agentOf.values());
  return rows.map((r) => {
    const agentId = agentOf.get(r.aggregateId) ?? null;
    return {
      id: r.id,
      at: r.createdAt,
      index: ELASTIC_INDICES.events,
      docId: r.id,
      doc: eventDoc({ ...r, worldId, agentId, agent: agentId ? (infos.get(agentId) ?? null) : null }),
    };
  });
};

const collectApplications: Collector = async (db, worldId, cursor, limit, settledBefore) => {
  const world = scoped(db, worldId);
  const rows = await world.selectFields(
    applications,
    {
      id: applications.id,
      agentId: applications.agentId,
      amountCents: applications.amountCents,
      termDays: applications.termDays,
      purpose: applications.purpose,
      invoiceRef: applications.invoiceRef,
      status: applications.status,
      decision: applications.decision,
      reasonCodes: applications.reasonCodes,
      adverseAction: applications.adverseAction,
      createdAt: applications.createdAt,
    },
    and(lt(applications.createdAt, settledBefore), after(applications.createdAt, applications.id, cursor)),
    order(applications.createdAt, applications.id),
    limit,
  );
  if (rows.length === 0) {
    return [];
  }
  // The decision's exact sim time: its loan.declined event (aggregate = the
  // application) or its loan.offered event (aggregate = the offer).
  const appIds = rows.map((r) => r.id);
  const offerRows = await world.selectFields(offers, { id: offers.id, applicationId: offers.applicationId }, inArray(offers.applicationId, appIds));
  const offerApp = new Map(offerRows.map((o) => [o.id, o.applicationId]));
  const eventRows = await world.selectFields(
    events,
    { aggregateId: events.aggregateId, occurredSimAt: events.occurredSimAt, type: events.type },
    and(
      inArray(events.aggregateId, [...appIds, ...offerApp.keys()]),
      inArray(events.type, ["loan.declined", "loan.offered"]),
    ),
  );
  const simAtOf = new Map<string, Date>();
  for (const e of eventRows) {
    const appId = offerApp.get(e.aggregateId) ?? e.aggregateId;
    if (!simAtOf.has(appId)) simAtOf.set(appId, e.occurredSimAt);
  }
  const toSim = await clockFor(db, worldId);
  const infos = await agentInfos(db, worldId, rows.map((r) => r.agentId));
  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt,
    index: ELASTIC_INDICES.applications,
    docId: r.id,
    doc: applicationDoc({
      ...r,
      worldId,
      agent: infos.get(r.agentId) ?? null,
      hasInvoice: r.invoiceRef !== null,
      simAt: simAtOf.get(r.id) ?? toSim(r.createdAt),
    }),
  }));
};

const collectNoteRedemptions: Collector = async (db, worldId, cursor, limit, settledBefore) => {
  const world = scoped(db, worldId);
  const rows = await world.selectFields(
    noteTransactions,
    {
      id: noteTransactions.id,
      positionId: noteTransactions.positionId,
      amountCents: noteTransactions.amountCents,
      status: noteTransactions.status,
      createdAt: noteTransactions.createdAt,
    },
    and(
      eq(noteTransactions.kind, "redeem"),
      lt(noteTransactions.createdAt, settledBefore),
      after(noteTransactions.createdAt, noteTransactions.id, cursor),
    ),
    order(noteTransactions.createdAt, noteTransactions.id),
    limit,
  );
  if (rows.length === 0) {
    return [];
  }
  const positions = await world.selectFields(
    notePositions,
    { id: notePositions.id, agentId: notePositions.agentId },
    inArray(notePositions.id, [...new Set(rows.map((r) => r.positionId))]),
  );
  const agentOf = new Map(positions.map((p) => [p.id, p.agentId]));
  const infos = await agentInfos(db, worldId, agentOf.values());
  const toSim = await clockFor(db, worldId);
  return rows.map((r) => {
    const agentId = agentOf.get(r.positionId) ?? null;
    return {
      id: r.id,
      at: r.createdAt,
      index: ELASTIC_INDICES.events,
      docId: `note_tx:${r.id}`,
      doc: noteRedemptionDoc({
        id: r.id,
        worldId,
        agentId,
        agent: agentId ? (infos.get(agentId) ?? null) : null,
        amountCents: r.amountCents,
        status: r.status,
        simAt: toSim(r.createdAt),
        createdAt: r.createdAt,
      }),
    };
  });
};

const UUID_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LOAN_SOURCE_PURPOSES = new Set(["loan_disbursement", "repayment_link", "guarantee"]);

const collectPaypalOps: Collector = async (db, worldId, cursor, limit, settledBefore) => {
  const world = scoped(db, worldId);
  const rows = await world.selectFields(
    paypalOperations,
    {
      id: paypalOperations.id,
      kind: paypalOperations.kind,
      purpose: paypalOperations.purpose,
      status: paypalOperations.status,
      rail: paypalOperations.rail,
      httpStatus: paypalOperations.httpStatus,
      attempts: paypalOperations.attempts,
      latencyMs: paypalOperations.latencyMs,
      paypalId: paypalOperations.paypalId,
      sourceId: paypalOperations.sourceId,
      request: paypalOperations.request,
      response: paypalOperations.response,
      simState: paypalOperations.simState,
      createdAt: paypalOperations.createdAt,
      updatedAt: paypalOperations.updatedAt,
    },
    and(lt(paypalOperations.updatedAt, settledBefore), after(paypalOperations.updatedAt, paypalOperations.id, cursor)),
    order(paypalOperations.updatedAt, paypalOperations.id),
    limit,
  );
  if (rows.length === 0) {
    return [];
  }
  // The loan behind each op: an order's repayment link, else a loan-keyed sourceId.
  const orderIds = rows.filter((r) => r.kind.startsWith("order.") && r.paypalId).map((r) => r.paypalId!);
  const linkLoan = new Map<string, string>();
  if (orderIds.length) {
    for (const l of await world.selectFields(
      repaymentLinks,
      { orderId: repaymentLinks.paypalOrderId, loanId: repaymentLinks.loanId },
      inArray(repaymentLinks.paypalOrderId, orderIds),
    )) {
      if (l.orderId) linkLoan.set(l.orderId, l.loanId);
    }
  }
  const loanOfOp = new Map<string, string>();
  for (const r of rows) {
    const viaLink = r.paypalId ? linkLoan.get(r.paypalId) : undefined;
    const viaSource = r.purpose && LOAN_SOURCE_PURPOSES.has(r.purpose) ? UUID_PREFIX_RE.exec(r.sourceId ?? "")?.[0] : undefined;
    const loanId = viaLink ?? viaSource;
    if (loanId) loanOfOp.set(r.id, loanId.toLowerCase());
  }
  const loanAgent = new Map<string, string>();
  const loanIds = [...new Set(loanOfOp.values())];
  if (loanIds.length) {
    for (const l of await world.selectFields(loans, { id: loans.id, agentId: loans.agentId }, inArray(loans.id, loanIds))) {
      loanAgent.set(l.id, l.agentId);
    }
  }
  const agentRows = loanAgent.size
    ? await world.selectFields(agents, { id: agents.id, principalId: agents.principalId, isBot: agents.isBot }, inArray(agents.id, [...new Set(loanAgent.values())]))
    : [];
  const principalIds = [...new Set(agentRows.map((a) => a.principalId).filter((p): p is string => p !== null))];
  // principals is a root table (no world_id); only the payer id is read, and only to hash it.
  const payerOfPrincipal = new Map<string, string | null>();
  if (principalIds.length) {
    const principalRows = await db
      .select({ id: principals.id, payerId: principals.paypalPayerId })
      .from(principals)
      .where(inArray(principals.id, principalIds));
    for (const p of principalRows) payerOfPrincipal.set(p.id, p.payerId);
  }
  const agentById = new Map(agentRows.map((a) => [a.id, a]));
  return rows.map((r) => {
    const loanId = loanOfOp.get(r.id) ?? null;
    const agentId = loanId ? (loanAgent.get(loanId) ?? null) : null;
    const agent = agentId ? agentById.get(agentId) : undefined;
    return {
      id: r.id,
      at: r.updatedAt,
      index: ELASTIC_INDICES.paypalOps,
      docId: r.id,
      doc: paypalOpDoc({
        id: r.id,
        worldId,
        kind: r.kind,
        purpose: r.purpose,
        status: r.status,
        rail: r.rail,
        httpStatus: r.httpStatus,
        attempts: r.attempts,
        latencyMs: r.latencyMs,
        amountCents: requestAmountCents(r.request),
        loanId,
        agentId,
        agent: agent ? { principalHash: hashId(agent.principalId), isBot: agent.isBot } : null,
        borrowerPayerId: agent?.principalId ? (payerOfPrincipal.get(agent.principalId) ?? null) : null,
        payerId: payerIdOf(r.response, r.simState),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }),
    };
  });
};

const COLLECTORS: Record<ShipStream, Collector> = {
  agents: collectAgents,
  events: collectEvents,
  applications: collectApplications,
  note_redemptions: collectNoteRedemptions,
  paypal_ops: collectPaypalOps,
};

// ------------------------------------------------------------------- ship

/**
 * Ships one world's new rows. Returns `null` (and does nothing) when
 * Elastic isn't configured. Never throws for an Elastic failure: the
 * stream's cursor keeps its place and records `last_error`.
 */
export async function shipWorld(
  db: Db,
  worldId: string,
  { now = new Date(), budget = SHIP_BATCH_PER_WORLD, settleMs = SHIP_SETTLE_MS, refresh = false }: {
    now?: Date;
    budget?: number;
    settleMs?: number;
    refresh?: boolean;
  } = {},
): Promise<ShipReport | null> {
  const client = elasticClient();
  if (!client) {
    return null;
  }
  const report: ShipReport = { worldId, shipped: {}, total: 0, errors: [] };
  const settledBefore = new Date(now.getTime() - settleMs);
  let remaining = budget;
  for (const stream of SHIP_STREAMS) {
    if (remaining <= 0) {
      break;
    }
    const cursor = await readCursor(db, worldId, stream);
    const pending = await COLLECTORS[stream](db, worldId, cursor, remaining, settledBefore);
    if (pending.length === 0) {
      continue;
    }
    let accepted = pending.length;
    let error: string | null = null;
    try {
      const result = await client.bulk({
        refresh,
        operations: pending.flatMap((p) => [{ index: { _index: p.index, _id: p.docId } }, p.doc]),
      });
      if (result.errors) {
        const firstFailed = result.items.findIndex((item) => Object.values(item)[0]?.error);
        accepted = firstFailed < 0 ? pending.length : firstFailed;
        const cause = firstFailed < 0 ? null : Object.values(result.items[firstFailed]!)[0]?.error;
        error = `bulk item rejected: ${cause?.type ?? "unknown"}`;
      }
    } catch (err) {
      accepted = 0;
      error = elasticErrorMessage(err);
    }
    const last = accepted > 0 ? pending[accepted - 1]! : null;
    await writeCursor(db, worldId, stream, {
      ...(last ? { at: last.at, id: last.id } : {}),
      shippedDelta: accepted,
      lastError: error,
    });
    remaining -= accepted;
    report.total += accepted;
    if (accepted > 0) report.shipped[stream] = accepted;
    if (error) {
      report.errors.push(`${stream}: ${error}`);
      // Elastic is unhappy: leave the remaining streams for the next tick.
      break;
    }
  }
  return report;
}
