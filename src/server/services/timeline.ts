import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { getSimDay, getSimNow, simNow as simNowFor } from "../clock/clock";
import type { Db } from "../db/client";
import {
  agents,
  clock,
  economyState,
  events,
  loanInstallments,
  loanLadderSteps,
  loans,
  notePositions,
  noteTransactions,
  offers,
  repaymentLinks,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { addDays, dayStart, planOrder, simDate } from "../domain/installments";
import { scrubText, shortLabel, type ConsoleWorld } from "./console";
import { agentsInView } from "./dashboard";
import { recentStressEvents } from "./stress";
import type { StoredTreasuryMemo } from "./treasuryMemo";

/**
 * P7 (Bryntum) — read models for the two schedule views.
 *
 * - `ownerTimeline`: the owner dashboard's Timeline tab (Bryntum
 *   Scheduler). Rows are the principal's agents in the selected view (the
 *   same `agentsInView` the dashboard uses); events are each loan
 *   (disbursed → due) with milestones for its installments
 *   (planned/paid/missed/failed — the agent drives them), the
 *   delinquency ladder steps, repayments and the guarantee. Read-only.
 * - `consoleCalendar`: the console's Calendar tab (Bryntum Calendar) for
 *   one world — loan due dates, installments, treasury memos, queued
 *   redemptions and stress events. Same visibility and PII rules as the
 *   console snapshot: agent names through `scrubText`, short ids only, no
 *   emails, payer ids, payout receivers or PayPal ids.
 *
 * Times are sim times (ISO). Money is integer cents.
 */

const DAY_MS = 86_400_000;
const LOAN_LIMIT = 200;

export type TimelineKind = "loan" | "installment" | "missed" | "ladder" | "repayment" | "guarantee";

export interface TimelineEvent {
  id: string;
  resourceId: string;
  kind: TimelineKind;
  /** The colour key: a loan / installment / ladder / link status. */
  state: string;
  name: string;
  startDate: string;
  endDate: string;
  amountCents: number | null;
  loan: string;
  /** Plain-text tooltip lines. */
  detail: string[];
}

export interface OwnerTimeline {
  generatedAt: string;
  simNow: string;
  world: { id: string | null; kind: "main" | "private" };
  resources: Array<{ id: string; name: string; status: string }>;
  events: TimelineEvent[];
}

function money(cents: bigint | number): string {
  const value = typeof cents === "bigint" ? Number(cents) : cents;
  return `$${(value / 100).toFixed(2)}`;
}

const LADDER_LABEL: Record<string, string> = {
  late: "Late (+1)",
  penalty: "Penalty (+3)",
  substandard: "Substandard (+7)",
  charged_off: "Charged off (+10)",
};

function installmentEvents(
  rows: Array<typeof loanInstallments.$inferSelect>,
  resourceId: string,
  loanLabel: string,
): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const row of planOrder(rows)) {
    const left = row.amountCents - row.paidCents;
    const at = new Date(row.dueOn.getTime() + DAY_MS / 2).toISOString();
    out.push({
      id: `inst:${row.id}`,
      resourceId,
      kind: "installment",
      state: row.status,
      name: `#${row.seq} ${money(row.amountCents)}`,
      startDate: at,
      endDate: at,
      amountCents: Number(row.amountCents),
      loan: loanLabel,
      detail: [
        `Installment ${row.seq} of ${loanLabel} · ${row.status.toUpperCase()}`,
        `Due ${simDate(row.dueOn)}${row.originalDueOn.getTime() !== row.dueOn.getTime() ? ` (planned ${simDate(row.originalDueOn)})` : ""}`,
        `${money(row.amountCents)} planned · ${money(row.paidCents)} paid${left > 0n ? ` · ${money(left)} left` : ""}`,
        `Agent moves ${row.moves}/2${row.autoMoved ? " · auto-moved once by the bank" : ""}`,
        ...(row.paidSimAt ? [`Paid ${row.paidSimAt.toISOString().slice(0, 16).replace("T", " ")} (sim)`] : []),
      ],
    });
    if (row.missedSimAt && row.status !== "missed") {
      // A miss the bank auto-moved (or that was paid late): keep the miss visible where it happened.
      const missedAt = new Date(row.missedSimAt.getTime() - DAY_MS / 2).toISOString();
      out.push({
        id: `miss:${row.id}`,
        resourceId,
        kind: "missed",
        state: "missed",
        name: `#${row.seq} missed`,
        startDate: missedAt,
        endDate: missedAt,
        amountCents: null,
        loan: loanLabel,
        detail: [`Installment ${row.seq} of ${loanLabel} was missed on ${simDate(addDays(row.missedSimAt, -1))}`],
      });
    }
  }
  return out;
}

async function loanTimelineEvents(db: Db, worldId: string, agentIds: string[], simNow: Date): Promise<TimelineEvent[]> {
  if (agentIds.length === 0) {
    return [];
  }
  const w = scoped(db, worldId);
  const loanRows = (await w.select(loans, inArray(loans.agentId, agentIds)))
    .filter((l) => l.status !== "accepted")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, LOAN_LIMIT);
  if (loanRows.length === 0) {
    return [];
  }
  const loanIds = loanRows.map((l) => l.id);
  const offerRows = await w.selectFields(offers, { id: offers.id, termDays: offers.termDays }, inArray(offers.id, loanRows.map((l) => l.offerId)));
  const termOf = new Map(offerRows.map((o) => [o.id, o.termDays]));
  const installments = await w.select(loanInstallments, inArray(loanInstallments.loanId, loanIds));
  const steps = await w.select(loanLadderSteps, inArray(loanLadderSteps.loanId, loanIds));
  const payments = await w.select(
    events,
    and(inArray(events.aggregateId, loanIds), inArray(events.type, ["loan.repayment_received", "loan.recovery_received"]))!,
  );
  const guarantees = await w.select(repaymentLinks, and(inArray(repaymentLinks.loanId, loanIds), eq(repaymentLinks.kind, "guarantee"))!);

  const out: TimelineEvent[] = [];
  for (const loan of loanRows) {
    const label = shortLabel("L", loan.id);
    const term = termOf.get(loan.offerId) ?? 14;
    const start = loan.disbursedSimAt ?? new Date(loan.dueSimAt.getTime() - term * DAY_MS);
    out.push({
      id: `loan:${loan.id}`,
      resourceId: loan.agentId,
      kind: "loan",
      state: loan.status,
      name: `${label} · ${money(loan.principalCents)}`,
      startDate: start.toISOString(),
      endDate: (loan.dueSimAt > start ? loan.dueSimAt : new Date(start.getTime() + DAY_MS)).toISOString(),
      amountCents: Number(loan.principalCents),
      loan: label,
      detail: [
        `${label} · ${loan.status.toUpperCase()}`,
        `${money(loan.principalCents)} principal + ${money(loan.feeCents)} fee · ${term} days`,
        `${loan.disbursedSimAt ? `Disbursed ${simDate(loan.disbursedSimAt)}` : "Disbursing"} → due ${simDate(loan.dueSimAt)}`,
        ...(["active", "late", "substandard"].includes(loan.status)
          ? [`Outstanding ${money(loan.outstandingCents + loan.lateFeeOutstandingCents + loan.penaltyOutstandingCents)}`]
          : []),
      ],
    });
    out.push(...installmentEvents(installments.filter((i) => i.loanId === loan.id), loan.agentId, label));
    for (const step of steps.filter((s) => s.loanId === loan.id)) {
      out.push({
        id: `step:${step.id}`,
        resourceId: loan.agentId,
        kind: "ladder",
        state: step.step,
        name: LADDER_LABEL[step.step] ?? step.step,
        startDate: step.appliedSimAt.toISOString(),
        endDate: step.appliedSimAt.toISOString(),
        amountCents: null,
        loan: label,
        detail: [`${label}: ${LADDER_LABEL[step.step] ?? step.step}`, `Applied ${simDate(step.appliedSimAt)} (fell due ${simDate(step.dueSimAt)})`],
      });
    }
    for (const event of payments.filter((e) => e.aggregateId === loan.id)) {
      const p = (event.payload ?? {}) as { gross_cents?: number; source?: string };
      const recovery = event.type === "loan.recovery_received";
      out.push({
        id: `pay:${event.id}`,
        resourceId: loan.agentId,
        kind: "repayment",
        state: recovery ? "recovery" : "repayment",
        name: `${recovery ? "Recovery" : "Paid"} ${money(p.gross_cents ?? 0)}`,
        startDate: event.occurredSimAt.toISOString(),
        endDate: event.occurredSimAt.toISOString(),
        amountCents: p.gross_cents ?? null,
        loan: label,
        detail: [
          `${label}: ${recovery ? "recovery" : "repayment"} of ${money(p.gross_cents ?? 0)}`,
          `${p.source ? `Via the ${p.source} link · ` : ""}${event.occurredSimAt.toISOString().slice(0, 16).replace("T", " ")} (sim)`,
        ],
      });
    }
    for (const link of guarantees.filter((g) => g.loanId === loan.id)) {
      const at = (loan.chargedOffAt ?? simNow).toISOString();
      out.push({
        id: `guar:${link.id}`,
        resourceId: loan.agentId,
        kind: "guarantee",
        state: `guarantee_${link.status}`,
        name: `Guarantee ${money(link.amountCents)}`,
        startDate: at,
        endDate: at,
        amountCents: Number(link.amountCents),
        loan: label,
        detail: [`${label}: owner guarantee invoked`, `${money(link.amountCents)} · link ${link.status.toUpperCase()}`],
      });
    }
  }
  return out;
}

/**
 * The owner's timeline for one dashboard view: `worldId` = one of the
 * principal's private worlds (the caller checked ownership), otherwise the
 * main view (their agents in non-private worlds).
 */
export async function ownerTimeline(
  db: Db,
  principalId: string,
  options: { worldId?: string; now?: Date } = {},
): Promise<OwnerTimeline> {
  const now = options.now ?? new Date();
  const owned = await agentsInView(db, principalId, options.worldId);
  const byWorld = new Map<string, string[]>();
  for (const agent of owned) {
    byWorld.set(agent.worldId, [...(byWorld.get(agent.worldId) ?? []), agent.id]);
  }
  let simNow: Date | null = null;
  const timelineEvents: TimelineEvent[] = [];
  for (const [worldId, ids] of byWorld) {
    const worldNow = await getSimNow(db, worldId, now);
    simNow = simNow ?? worldNow;
    timelineEvents.push(...(await loanTimelineEvents(db, worldId, ids, worldNow)));
  }
  if (!simNow) {
    simNow = options.worldId ? await getSimNow(db, options.worldId, now) : now;
  }
  return {
    generatedAt: now.toISOString(),
    simNow: simNow.toISOString(),
    world: { id: options.worldId ?? null, kind: options.worldId ? "private" : "main" },
    resources: owned.map((a) => ({ id: a.id, name: a.name, status: a.status })),
    events: timelineEvents,
  };
}

// ---------------------------------------------------------------------
// Console calendar
// ---------------------------------------------------------------------

export type CalendarKind = "due" | "installment" | "memo" | "redemption" | "stress";

export interface CalendarEvent {
  id: string;
  calendar: CalendarKind;
  name: string;
  startDate: string;
  endDate: string;
  allDay: boolean;
  state: string;
  detail: string[];
}

export interface ConsoleCalendar {
  generatedAt: string;
  world: ConsoleWorld;
  simNow: string;
  events: CalendarEvent[];
}

const STRESS_LABEL: Record<string, string> = {
  default_wave: "Stress: default wave",
  note_run: "Stress: note run",
  rate_spike: "Stress: rate spike",
};

/**
 * Loan statuses that still have a due date ahead of (or behind) them: in
 * flight, owing, or charged off and unrecovered. A settled loan (REPAID,
 * RECOVERED) or one that never funded gets no "due" event on the Calendar.
 */
const DUE_EVENT_STATUSES: ReadonlySet<string> = new Set(["disbursing", "active", "late", "substandard", "charged_off"]);

export function showsDueEvent(status: string): boolean {
  return DUE_EVENT_STATUSES.has(status);
}

function dayRange(at: Date): { startDate: string; endDate: string } {
  const start = dayStart(at);
  return { startDate: start.toISOString(), endDate: addDays(start, 1).toISOString() };
}

export async function consoleCalendar(db: Db, world: ConsoleWorld, realNow: Date = new Date()): Promise<ConsoleCalendar> {
  const w = scoped(db, world.id);
  const { simNow, anchorSim } = await getSimDay(db, world.id, realNow);
  const agentRows = await w.selectFields(agents, { id: agents.id, name: agents.name });
  const nameOf = new Map(agentRows.map((a) => [a.id, scrubText(a.name)]));
  const out: CalendarEvent[] = [];

  // Loan due dates (funded loans; the newest LOAN_LIMIT).
  const loanRows = (await w.select(loans))
    .filter((l) => l.status !== "accepted" && l.status !== "disbursement_failed")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, LOAN_LIMIT);
  for (const loan of loanRows) {
    if (!showsDueEvent(loan.status)) {
      continue; // settled (repaid/recovered): nothing is due any more
    }
    const label = shortLabel("L", loan.id);
    const agent = nameOf.get(loan.agentId) ?? "—";
    out.push({
      id: `due:${loan.id}`,
      calendar: "due",
      name: `${label} due · ${agent}`,
      ...dayRange(loan.dueSimAt),
      allDay: true,
      state: loan.status,
      detail: [
        `${label} (${agent}) · ${loan.status.toUpperCase()}`,
        `${money(loan.principalCents + loan.feeCents)} principal + fee due ${simDate(loan.dueSimAt)}`,
      ],
    });
  }

  // Installments the borrowers planned.
  const loanIds = loanRows.map((l) => l.id);
  const installments = loanIds.length ? await w.select(loanInstallments, inArray(loanInstallments.loanId, loanIds)) : [];
  for (const row of installments) {
    const label = shortLabel("L", row.loanId);
    const agent = nameOf.get(row.agentId) ?? "—";
    out.push({
      id: `inst:${row.id}`,
      calendar: "installment",
      name: `${label} #${row.seq} ${money(row.amountCents)} · ${row.status}`,
      ...dayRange(row.dueOn),
      allDay: true,
      state: row.status,
      detail: [
        `${agent}'s installment ${row.seq} for ${label} · ${row.status.toUpperCase()}`,
        `${money(row.amountCents)} planned · ${money(row.paidCents)} paid`,
        row.autoMoved ? "Auto-moved once after a miss" : `Moved by the agent ${row.moves}×`,
      ],
    });
  }

  // Treasury memos (one per sim day).
  const memos = await w.selectFields(
    economyState,
    { simDay: economyState.simDay, treasuryMemo: economyState.treasuryMemo },
    isNotNull(economyState.treasuryMemo),
  );
  for (const row of memos) {
    const memo = row.treasuryMemo as StoredTreasuryMemo | null;
    if (!memo) {
      continue;
    }
    const at = addDays(dayStart(anchorSim), row.simDay);
    out.push({
      id: `memo:${row.simDay}`,
      calendar: "memo",
      name: `Treasury memo · ${scrubText(memo.headline)}`.slice(0, 120),
      ...dayRange(at),
      allDay: true,
      state: memo.source,
      detail: [`Day ${row.simDay} treasury memo (${memo.source})`, scrubText(memo.headline)],
    });
  }

  // Queued redemptions: from the sim day each was queued until today (they wait behind the reserve floor).
  const [clockRow] = await w.select(clock);
  const queued = await w.select(noteTransactions, and(eq(noteTransactions.kind, "redeem"), eq(noteTransactions.status, "queued"))!);
  if (queued.length > 0 && clockRow) {
    const positions = await w.selectFields(
      notePositions,
      { id: notePositions.id, agentId: notePositions.agentId },
      inArray(notePositions.id, queued.map((q) => q.positionId)),
    );
    const holderOf = new Map(positions.map((p) => [p.id, nameOf.get(p.agentId) ?? "—"]));
    const state = {
      anchorReal: clockRow.anchorReal,
      anchorSim: clockRow.anchorSim,
      speed: Number(clockRow.speed),
      manualOffsetMs: clockRow.manualOffsetMs,
    };
    const ordered = queued.slice().sort((a, b) => (a.queuedAt?.getTime() ?? 0) - (b.queuedAt?.getTime() ?? 0));
    for (const [index, tx] of ordered.entries()) {
      const queuedSim = tx.queuedAt ? simNowFor(state, tx.queuedAt) : simNow;
      const from = dayStart(queuedSim < simNow ? queuedSim : simNow);
      out.push({
        id: `redeem:${tx.id}`,
        calendar: "redemption",
        name: `Queued redemption ${money(tx.amountCents)} · ${holderOf.get(tx.positionId) ?? "—"}`,
        startDate: from.toISOString(),
        endDate: addDays(dayStart(simNow), 1).toISOString(),
        allDay: true,
        state: "queued",
        detail: [`Queue position ${index + 1} · ${money(tx.amountCents)}`, "Paid in FIFO order once cash is above the reserve floor."],
      });
    }
  }

  // Stress events.
  for (const stress of await recentStressEvents(db, world.id, 50)) {
    out.push({
      id: `stress:${stress.id}`,
      calendar: "stress",
      name: STRESS_LABEL[stress.scenario] ?? `Stress: ${stress.scenario}`,
      startDate: stress.occurredSimAt.toISOString(),
      endDate: new Date(stress.occurredSimAt.getTime() + 60 * 60 * 1000).toISOString(),
      allDay: false,
      state: stress.scenario,
      detail: [
        `${STRESS_LABEL[stress.scenario] ?? stress.scenario} on day ${stress.simDay}`,
        ...(stress.loansTaken !== undefined ? [`${stress.loansTaken} loan(s) taken into the wave`] : []),
      ],
    });
  }

  return { generatedAt: realNow.toISOString(), world, simNow: simNow.toISOString(), events: out };
}
