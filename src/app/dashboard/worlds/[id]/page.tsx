import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { requirePagePrincipal } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import {
  privateWorldView,
  type BotView,
  type OwnerLoanView,
  type WorldEconomyView,
} from "@/server/services/privateWorlds";
import type { StressEventView } from "@/server/services/stress";

import { drawerHref, loanPill } from "../../_components/cards";
import { DashFrame, LEGAL, LoadingFrame, Pill, TopBar } from "../../_components/chrome";
import { formatBps, formatCents, formatDate, loanLabel } from "../../_components/format";
import "../../dashboard.css";

export const metadata: Metadata = {
  title: "Mandate · Sandbox world",
  robots: { index: false, follow: false },
};

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const ACTION_LABEL: Record<string, string> = {
  buy_notes: "bought notes",
  redeem_notes: "redeemed notes",
  apply_for_loan: "applied for a loan",
  accept_offer: "accepted the offer",
  client_paid_invoice: "invoice paid by the client",
  repay_loan: "repaid the loan",
  default_wave_loan: "loan caught in the default wave (won't be repaid)",
  error: "hit an error",
};

const ARCHETYPE_LABEL: Record<string, string> = {
  good: "Good payer",
  late: "Late payer (+3 days)",
  defaulter: "Defaulter",
};

/** P5 Task 4: the scenario buttons on the world page. */
const STRESS_BUTTONS: Array<{ scenario: string; label: string; what: string }> = [
  { scenario: "default_wave", label: "Default wave", what: "the next 3 bot loans are never repaid" },
  { scenario: "note_run", label: "Note run", what: "every lender bot asks for all its money back" },
  { scenario: "rate_spike", label: "Rate spike", what: "the base rate jumps +5% tomorrow, then eases back" },
];

const STRESS_LABEL: Record<string, string> = {
  default_wave: "Default wave",
  note_run: "Note run",
  rate_spike: "Rate spike",
};

function stressDetail(event: StressEventView): string {
  const params = event.params as Record<string, unknown>;
  switch (event.scenario) {
    case "default_wave":
      return `next ${String(params.loans ?? 3)} bot loans skip repayment · ${event.loansTaken ?? 0} taken so far`;
    case "rate_spike":
      return `+${String(params.bump_bps ?? 500)} bps on day ${String(params.apply_sim_day ?? event.simDay + 1)}, then mean-reverts`;
    case "note_run": {
      const requests = Array.isArray(params.requests) ? (params.requests as Array<{ bot: string; amount_cents: number; status: string }>) : [];
      return requests.length === 0
        ? "no lender held redeemable notes"
        : requests.map((r) => `${r.bot} ${formatCents(r.amount_cents)} ${r.status.toLowerCase()}`).join(" · ");
    }
  }
}

/** P5 Task 4: today's economy and treasury, plus the latest treasury memo. */
function EconomyPanel({ economy }: { economy: WorldEconomyView }) {
  const realBps = economy.baseRateBps - economy.inflationRateBps;
  return (
    <section className="panel" aria-labelledby="econ-h" data-testid="economy-panel">
      <h2 id="econ-h">Economy · day {economy.simDay}</h2>
      <div className="kv">
        <span>Base rate</span>
        <b className="num" data-testid="econ-base-rate">
          {formatBps(economy.baseRateBps)}
          {economy.rateSpike ? " (rate spike)" : ""}
        </b>
        <span>Inflation (index)</span>
        <b className="num">
          {formatBps(economy.inflationRateBps)} ({(economy.inflationIndexBp / 10000).toFixed(4)}) · real {formatBps(realBps)}
        </b>
        <span>Utilization (premium)</span>
        <b className="num" data-testid="econ-utilization">
          {formatBps(economy.utilizationBps)} (+{economy.utilizationPremiumBps} bps)
        </b>
        <span>Reserve ratio (floor)</span>
        <b className="num">
          {formatBps(economy.reserveRatioBps)} ({formatCents(economy.reserveFloorCents)})
        </b>
        <span>Loss allowance (gross of note-holder loss sharing)</span>
        <b className="num" data-testid="econ-allowance">
          {formatCents(economy.allowanceCents)}
        </b>
        <span>Cash</span>
        <b className="num">{formatCents(economy.cashCents)}</b>
        <span>Today&apos;s lending budget used</span>
        <b className="num">
          {economy.dailyBudgetCents === null
            ? `${formatCents(economy.budgetUsedCents)} (no budget yet)`
            : `${formatCents(economy.budgetUsedCents)} of ${formatCents(economy.dailyBudgetCents)}`}
        </b>
        <span>Redemption queue</span>
        <b className="num" data-testid="econ-queue">
          {economy.queuedRedemptions} ({formatCents(economy.queuedRedemptionCents)})
        </b>
      </div>
      {economy.memo ? (
        <div data-testid="treasury-memo">
          <h3>
            Treasury memo · day {economy.memo.sim_day} <small>({economy.memo.source}, advisory)</small>
          </h3>
          <p>{economy.memo.headline}</p>
          {economy.memo.risks.length > 0 ? (
            <ul>
              {economy.memo.risks.map((risk, i) => (
                <li key={i}>{risk}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function BotCard({ bot }: { bot: BotView }) {
  return (
    <div className="bot" data-testid="bot-card">
      <h3>
        <span>{bot.name}</span>
        <Pill tone={bot.role === "lender" ? "ok" : "blue"}>{bot.role === "lender" ? "Lender" : "Borrower"}</Pill>
      </h3>
      {bot.archetype ? <small data-testid="bot-archetype">{ARCHETYPE_LABEL[bot.archetype] ?? bot.archetype}</small> : null}
      {bot.role === "lender" ? (
        <div className="kv">
          <span>Notes held</span>
          <b className="num">{formatCents(bot.notesCents)}</b>
        </div>
      ) : (
        <div className="kv">
          <span>Open loan</span>
          <b className="num">{bot.openLoan ? formatCents(bot.openLoan.outstandingCents) : "—"}</b>
          <span>Due</span>
          <b>{bot.openLoan ? formatDate(bot.openLoan.dueSimAt) : "—"}</b>
          <span>Loans repaid</span>
          <b className="num">{bot.loansRepaid}</b>
        </div>
      )}
      <small>Mandate bots · simulated</small>
    </div>
  );
}

const STEP_LABEL: Record<string, string> = {
  late: "late (+1 day: late fee)",
  penalty: "penalty (+3 days: 2% a year accrues)",
  substandard: "substandard (+7 days: agent restricted, mandate frozen)",
  charged_off: "charged off (+10 days: your guarantee is invoked)",
};

/** P4 Task 4: one of the owner's agents' loans — its due day and ladder step, so +1 / +7 can walk it down the ladder. */
function OwnerLoanRow({ loan, simDay }: { loan: OwnerLoanView; simDay: number }) {
  const pill = loanPill(loan.status);
  return (
    <li data-testid="world-loan" data-loan-id={loan.loanId}>
      <div>
        <b>
          {loan.agentName} · <span className="mono">{loanLabel(loan.loanId)}</span>
        </b>{" "}
        <span className="num">{formatCents(loan.principalCents)}</span>
        <small data-testid="world-loan-due">
          Due day {loan.dueDay}
          {loan.daysLate > 0 ? ` · ${loan.daysLate} ${loan.daysLate === 1 ? "day" : "days"} late` : simDay <= loan.dueDay && loan.next ? ` · ${loan.dueDay - simDay} days to go` : ""}
          {loan.dueNowCents > 0n ? ` · ${formatCents(loan.dueNowCents)} ${loan.status === "charged_off" ? "recoverable" : "to settle"}` : ""}
        </small>
        <small data-testid="world-loan-step">
          Ladder step: {loan.step ? STEP_LABEL[loan.step] ?? loan.step : "none yet"}
          {loan.next ? ` · next: ${loan.next.step.replace("_", " ")} on day ${loan.next.day}` : ""}
        </small>
      </div>
      <Pill tone={pill.tone}>{pill.label}</Pill>
      <a className="btn sm" href={drawerHref(loan.agentId)}>
        Details
      </a>
    </li>
  );
}

/**
 * `/dashboard/worlds/[id]` — P2 Task 6: one private sandbox world: its
 * simulated date, the clock controls (+1 / +7 days — the bots act for
 * each day — and Reset), the pool, the bots and what they did lately.
 * Owner only: anyone else (or an archived world) gets a 404.
 */
async function World({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { id } = await params;
  const query = await searchParams;
  const session = await requirePagePrincipal(`/dashboard/worlds/${encodeURIComponent(id)}`);
  const view = await privateWorldView(await getDb(), session.principalId, id);
  if (!view) {
    notFound();
  }
  const advanced = one(query.advanced);
  const failed = one(query.error);

  return (
    <DashFrame>
      <TopBar principalId={session.principalId} worldId={view.world.id} current="worlds" />
      <main className="page">
        <Link className="crumb" href="/dashboard/worlds">
          ← Sandbox worlds
        </Link>
        <div className="head">
          <div>
            <h1 data-testid="world-name">{view.world.name}</h1>
            <p className="sub">
              Private sandbox · sim rail only · <span data-testid="sim-date">Day {view.simDay} · {formatDate(view.simNow)}</span>
            </p>
          </div>
          <div className="clock" data-testid="clock-controls">
            <form method="post" action={`/dashboard/worlds/${view.world.id}/advance`}>
              <input type="hidden" name="days" value="1" />
              <button type="submit" className="btn">
                +1 day
              </button>
            </form>
            <form method="post" action={`/dashboard/worlds/${view.world.id}/advance`}>
              <input type="hidden" name="days" value="7" />
              <button type="submit" className="btn primary">
                +7 days
              </button>
            </form>
            <form method="post" action={`/dashboard/worlds/${view.world.id}/reset`}>
              <button type="submit" className="btn danger">
                Reset
              </button>
            </form>
          </div>
        </div>

        {advanced ? (
          <div className="notice ok" role="status">
            Moved the clock {advanced === "1" ? "1 day" : `${advanced} days`}; the bots acted each day.
          </div>
        ) : null}
        {one(query.reset) ? (
          <div className="notice ok" role="status">
            Fresh world opened; the old one is archived.
          </div>
        ) : null}
        {one(query.created) ? (
          <div className="notice ok" role="status">
            World created. The lender bots have funded the pool — move the clock to watch the bank run.
          </div>
        ) : null}
        {one(query.stress) ? (
          <div className="notice ok" role="status">
            {STRESS_LABEL[one(query.stress)!] ?? "Scenario"} triggered — move the clock to watch the bank absorb it.
          </div>
        ) : null}
        {failed ? (
          <div className="notice err" role="alert">
            Something went wrong. Please try again.
          </div>
        ) : null}

        <div className="stats" role="list" aria-label="Pool">
          <div className="stat" role="listitem" data-testid="stat-notes">
            <b className="num">{formatCents(view.notesOutstandingCents)}</b>
            <span>Notes outstanding</span>
          </div>
          <div className="stat" role="listitem" data-testid="stat-loans">
            <b className="num">{formatCents(view.loansOutstandingCents)}</b>
            <span>
              Lent out · {view.openLoans} open, {view.repaidLoans} repaid
            </span>
          </div>
          <div className="stat" role="listitem" data-testid="stat-liquidity">
            <b className="num">{formatCents(view.liquidityCents)}</b>
            <span>Available to lend</span>
          </div>
        </div>

        {view.economy ? <EconomyPanel economy={view.economy} /> : null}

        <section className="panel" aria-labelledby="stress-h" data-testid="stress-panel">
          <h2 id="stress-h">Stress scenarios</h2>
          <p>Test how the bank copes. Each one is recorded below; move the clock to watch it play out.</p>
          <div className="clock">
            {STRESS_BUTTONS.map((button) => (
              <form key={button.scenario} method="post" action={`/dashboard/worlds/${view.world.id}/stress`}>
                <input type="hidden" name="scenario" value={button.scenario} />
                <button type="submit" className="btn" title={button.what} data-testid={`stress-${button.scenario}`}>
                  {button.label}
                </button>
              </form>
            ))}
          </div>
          {view.stressEvents.length > 0 ? (
            <ul className="daylog" data-testid="stress-log">
              {view.stressEvents.map((event) => (
                <li key={event.id}>
                  <b>
                    {STRESS_LABEL[event.scenario] ?? event.scenario} · day {event.simDay}
                  </b>
                  <ul>
                    <li>{stressDetail(event)}</li>
                  </ul>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {view.ownerLoans.length > 0 ? (
          <section className="panel" aria-labelledby="ladder-h" data-testid="world-loans">
            <h2 id="ladder-h">Your agents&apos; loans</h2>
            <p>
              Due days are on this world&apos;s clock (today is day {view.simDay}). Unpaid after the due day, a loan walks
              the ladder: +1 late fee, +3 rate penalty, +7 substandard, +10 charged off and your guarantee invoked. Use
              +1 / +7 to watch it happen.
            </p>
            <ul className="ladder">
              {view.ownerLoans.map((loan) => (
                <OwnerLoanRow key={loan.loanId} loan={loan} simDay={view.simDay} />
              ))}
            </ul>
          </section>
        ) : null}

        <section className="panel" aria-labelledby="bots-h">
          <h2 id="bots-h">Bots</h2>
          <p>
            They use the same tools as any agent (buy_notes, apply_for_loan, accept_offer, repay_loan). Lenders buy more
            when the real return is above 2% and redeem when it is below 0; borrowers are good payers (their invoice client
            pays before the due date), late payers (+3 days) or defaulters.
          </p>
          <div className="botgrid">
            {view.bots.map((bot) => (
              <BotCard key={bot.id} bot={bot} />
            ))}
          </div>
        </section>

        <section className="panel" aria-labelledby="log-h">
          <h2 id="log-h">Recent days</h2>
          {view.recentDays.length === 0 ? (
            <p>Nothing yet — move the clock.</p>
          ) : (
            <ul className="daylog" data-testid="day-log">
              {view.recentDays.map((day) => (
                <li key={`${day.day}-${day.occurredSimAt.toISOString()}`}>
                  <b>
                    Day {day.day} · {formatDate(day.occurredSimAt)}
                  </b>
                  {day.actions.length === 0 ? (
                    <ul>
                      <li>Quiet day.</li>
                    </ul>
                  ) : (
                    <ul>
                      {day.actions.map((action, i) => (
                        <li key={i}>
                          {action.bot} {ACTION_LABEL[action.action] ?? action.action}
                          {action.amountCents !== undefined ? ` · ${formatCents(action.amountCents)}` : ""} ·{" "}
                          {action.status.toLowerCase()}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="mine-h">
          <h2 id="mine-h">Your agents here</h2>
          <p>
            Register an agent into this world to trade with the bots. Its API key works only here; trial balance{" "}
            <span className="num" data-testid="trial-balance">
              {formatCents(view.trialBalanceCents)}
            </span>
            .
          </p>
          <div className="clock">
            <Link className="btn primary" href={`/dashboard/agents/new?world=${view.world.id}`}>
              + Register an agent here
            </Link>
            <Link className="btn" href={`/dashboard?world=${view.world.id}`}>
              My agents in this world
            </Link>
          </div>
        </section>
        <p className="pagelegal">{LEGAL}</p>
      </main>
    </DashFrame>
  );
}

export default function WorldPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  return (
    <Suspense fallback={<LoadingFrame />}>
      <World params={params} searchParams={searchParams} />
    </Suspense>
  );
}
