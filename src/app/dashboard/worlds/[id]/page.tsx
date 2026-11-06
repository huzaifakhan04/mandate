import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { requirePagePrincipal } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { privateWorldView, type BotView } from "@/server/services/privateWorlds";

import { DashFrame, LEGAL, LoadingFrame, Pill, TopBar } from "../../_components/chrome";
import { formatCents, formatDate } from "../../_components/format";
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
  error: "hit an error",
};

function BotCard({ bot }: { bot: BotView }) {
  return (
    <div className="bot" data-testid="bot-card">
      <h3>
        <span>{bot.name}</span>
        <Pill tone={bot.role === "lender" ? "ok" : "blue"}>{bot.role === "lender" ? "Lender" : "Borrower"}</Pill>
      </h3>
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

        <section className="panel" aria-labelledby="bots-h">
          <h2 id="bots-h">Bots</h2>
          <p>
            They use the same tools as any agent (buy_notes, apply_for_loan, accept_offer); each borrower&apos;s invoice
            client pays its link before the due date.
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
