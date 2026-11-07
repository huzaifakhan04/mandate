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
import { Crumb, LEGAL, LoadingFrame, OwnerShell, Pill } from "../../_components/chrome";
import { formatBps, formatCents, formatDate, formatShortDate, loanLabel } from "../../_components/format";
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
      const requests = Array.isArray(params.requests)
        ? (params.requests as Array<{ bot: string; amount_cents: number; status: string }>)
        : [];
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
    <section className="sec" aria-labelledby="econ-h" data-testid="economy-panel">
      <div className="sec-h">
        <h2 id="econ-h">Economy · day {economy.simDay}</h2>
      </div>
      <dl className="drows num">
        <dt>Base rate</dt>
        <dd data-testid="econ-base-rate">
          {formatBps(economy.baseRateBps)}
          {economy.rateSpike ? " (rate spike)" : ""}
        </dd>
        <dt>Inflation (index)</dt>
        <dd>
          {formatBps(economy.inflationRateBps)} ({(economy.inflationIndexBp / 10000).toFixed(4)}) · real{" "}
          {formatBps(realBps)}
        </dd>
        <dt>Utilization (premium)</dt>
        <dd data-testid="econ-utilization">
          {formatBps(economy.utilizationBps)} (+{economy.utilizationPremiumBps} bps)
        </dd>
        <dt>Reserve ratio (floor)</dt>
        <dd>
          {formatBps(economy.reserveRatioBps)} ({formatCents(economy.reserveFloorCents)})
        </dd>
        <dt>Loss allowance (gross of note-holder loss sharing)</dt>
        <dd data-testid="econ-allowance">{formatCents(economy.allowanceCents)}</dd>
        <dt>Cash</dt>
        <dd>{formatCents(economy.cashCents)}</dd>
        <dt>Today&apos;s lending budget used</dt>
        <dd>
          {economy.dailyBudgetCents === null
            ? `${formatCents(economy.budgetUsedCents)} (no budget yet)`
            : `${formatCents(economy.budgetUsedCents)} of ${formatCents(economy.dailyBudgetCents)}`}
        </dd>
        <dt>Redemption queue</dt>
        <dd data-testid="econ-queue">
          {economy.queuedRedemptions} ({formatCents(economy.queuedRedemptionCents)})
        </dd>
      </dl>
      {economy.memo ? (
        <div className="memo" data-testid="treasury-memo">
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
    <li className="bot" data-testid="bot-card">
      <span className="bot-n">
        <b>{bot.name}</b>
        {bot.archetype ? (
          <small data-testid="bot-archetype">{ARCHETYPE_LABEL[bot.archetype] ?? bot.archetype}</small>
        ) : (
          <small>Mandate bot · simulated</small>
        )}
      </span>
      <span className="bot-r">
        <Pill tone={bot.role === "lender" ? "ok" : "blue"}>{bot.role === "lender" ? "Lender" : "Borrower"}</Pill>
      </span>
      {bot.role === "lender" ? (
        <span className="bot-f num">
          <span className="faint">Notes held</span> {formatCents(bot.notesCents)}
        </span>
      ) : (
        <span className="bot-f num">
          <span className="faint">Open loan</span> {bot.openLoan ? formatCents(bot.openLoan.outstandingCents) : "—"}
          <span className="faint"> · due</span> {bot.openLoan ? formatShortDate(bot.openLoan.dueSimAt) : "—"}
          <span className="faint"> · repaid</span> {bot.loansRepaid}
        </span>
      )}
    </li>
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
    <tr data-testid="world-loan" data-loan-id={loan.loanId}>
      <td>
        <b>{loan.agentName}</b> <span className="mono faint">{loanLabel(loan.loanId)}</span>
      </td>
      <td className="n">{formatCents(loan.principalCents)}</td>
      <td data-testid="world-loan-due">
        Due day {loan.dueDay}
        {loan.daysLate > 0
          ? ` · ${loan.daysLate} ${loan.daysLate === 1 ? "day" : "days"} late`
          : simDay <= loan.dueDay && loan.next
            ? ` · ${loan.dueDay - simDay} days to go`
            : ""}
        {loan.dueNowCents > 0n
          ? ` · ${formatCents(loan.dueNowCents)} ${loan.status === "charged_off" ? "recoverable" : "to settle"}`
          : ""}
      </td>
      <td data-testid="world-loan-step">
        Ladder step: {loan.step ? (STEP_LABEL[loan.step] ?? loan.step) : "none yet"}
        {loan.next ? ` · next: ${loan.next.step.replace("_", " ")} on day ${loan.next.day}` : ""}
      </td>
      <td>
        <Pill tone={pill.tone}>{pill.label}</Pill>
      </td>
      <td className="n">
        <a className="ui-btn ghost" href={drawerHref(loan.agentId)}>
          Details
        </a>
      </td>
    </tr>
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
    <OwnerShell
      principalId={session.principalId}
      worldId={view.world.id}
      current="worlds"
      clock="controls"
      crumb={<Crumb items={[{ label: "Sandbox worlds", href: "/dashboard/worlds" }]} />}
    >
      <div className="dl world">
        <div className="ph">
          <div>
            <h1>{view.world.name}</h1>
            <p>
              <span className="ui-tag sim">Private sandbox</span> sim rail only: simulated money, never PayPal.
            </p>
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

        <div className="sum" role="list" aria-label="Pool">
          <div role="listitem" data-testid="stat-notes">
            Notes outstanding<b className="num">{formatCents(view.notesOutstandingCents)}</b>
          </div>
          <div role="listitem" data-testid="stat-loans">
            Lent out · {view.openLoans} open, {view.repaidLoans} repaid
            <b className="num">{formatCents(view.loansOutstandingCents)}</b>
          </div>
          <div role="listitem" data-testid="stat-liquidity">
            Available to lend<b className="num">{formatCents(view.liquidityCents)}</b>
          </div>
        </div>

        {view.economy ? <EconomyPanel economy={view.economy} /> : null}

        <section className="sec" aria-labelledby="stress-h" data-testid="stress-panel">
          <div className="sec-h">
            <h2 id="stress-h">Stress scenarios</h2>
          </div>
          <p className="sec-p">
            Test how the bank copes. Each one is recorded below; move the clock to watch it play out.
          </p>
          <div className="btnrow">
            {STRESS_BUTTONS.map((button) => (
              <form key={button.scenario} method="post" action={`/dashboard/worlds/${view.world.id}/stress`}>
                <input type="hidden" name="scenario" value={button.scenario} />
                <button type="submit" className="ui-btn" title={button.what} data-testid={`stress-${button.scenario}`}>
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
          <section className="sec" aria-labelledby="ladder-h" data-testid="world-loans">
            <div className="sec-h">
              <h2 id="ladder-h">Your agents&apos; loans</h2>
            </div>
            <p className="sec-p">
              Due days are on this world&apos;s clock (today is day {view.simDay}). Unpaid after the due day, a loan
              walks the ladder: +1 late fee, +3 rate penalty, +7 substandard, +10 charged off and your guarantee
              invoked. Use +1 / +7 to watch it happen.
            </p>
            <table className="t ladder">
              <thead>
                <tr>
                  <th>Loan</th>
                  <th className="n">Principal</th>
                  <th>Due</th>
                  <th>Ladder</th>
                  <th>Status</th>
                  <th className="n">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.ownerLoans.map((loan) => (
                  <OwnerLoanRow key={loan.loanId} loan={loan} simDay={view.simDay} />
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        <section className="sec" aria-labelledby="bots-h">
          <div className="sec-h">
            <h2 id="bots-h">Bots</h2>
            <span className="faint num">{view.bots.length}</span>
          </div>
          <p className="sec-p">
            They use the same tools as any agent (buy_notes, apply_for_loan, accept_offer, repay_loan). Lenders buy more
            when the real return is above 2% and redeem when it is below 0; borrowers are good payers (their invoice
            client pays before the due date), late payers (+3 days) or defaulters.
          </p>
          <ul className="botlist">
            {view.bots.map((bot) => (
              <BotCard key={bot.id} bot={bot} />
            ))}
          </ul>
        </section>

        <section className="sec" aria-labelledby="log-h">
          <div className="sec-h">
            <h2 id="log-h">Recent days</h2>
          </div>
          {view.recentDays.length === 0 ? (
            <p className="empty">Nothing yet — move the clock.</p>
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

        <section className="sec" aria-labelledby="mine-h">
          <div className="sec-h">
            <h2 id="mine-h">Your agents here</h2>
          </div>
          <p className="sec-p">
            Register an agent into this world to trade with the bots. Its API key works only here; trial balance{" "}
            <span className="num" data-testid="trial-balance">
              {formatCents(view.trialBalanceCents)}
            </span>
            .
          </p>
          <div className="btnrow">
            <Link className="ui-btn primary" href={`/dashboard/agents/new?world=${view.world.id}`}>
              + Register an agent here
            </Link>
            <Link className="ui-btn" href={`/dashboard?world=${view.world.id}`}>
              My agents in this world
            </Link>
          </div>
        </section>
        <p className="ui-legal pagelegal">{LEGAL}</p>
      </div>
    </OwnerShell>
  );
}

export default function WorldPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  return (
    <Suspense fallback={<LoadingFrame />}>
      <World params={params} searchParams={searchParams} />
    </Suspense>
  );
}
