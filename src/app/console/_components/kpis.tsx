"use client";

import type { ConsoleSnapshot } from "@/server/services/console";

import { money, moneyShort, pct } from "./format";

const SPARK_W = 320;
const SPARK_H = 56;

/**
 * The cash line: one muted unfilled stroke, a dotted baseline at the first
 * value, and an endpoint dot (drawn in HTML so it stays round when the SVG
 * stretches to the column width).
 */
function CashLine({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) {
    return (
      <div className="spark" role="img" aria-label={label}>
        <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1={SPARK_H / 2} x2={SPARK_W} y2={SPARK_H / 2} />
        </svg>
      </div>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const y = (v: number) => (max === min ? SPARK_H / 2 : SPARK_H - 4 - ((v - min) / span) * (SPARK_H - 8));
  const d = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${((i / (values.length - 1)) * SPARK_W).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
  const endY = y(values[values.length - 1]!);
  return (
    <div className="spark" role="img" aria-label={label}>
      <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1={y(values[0]!)} x2={SPARK_W} y2={y(values[0]!)} />
        <path d={d} />
      </svg>
      <i style={{ top: `${(endY / SPARK_H) * 100}%` }} aria-hidden="true" />
    </div>
  );
}

function deltaText(values: number[], format: (n: number) => string): string {
  if (values.length < 2) {
    return "no history yet";
  }
  const delta = values[values.length - 1]! - values[0]!;
  if (delta === 0) {
    return `flat · ${values.length}d`;
  }
  return `${delta > 0 ? "+" : "−"}${format(Math.abs(delta))} · ${values.length}d`;
}

/**
 * The KPI area, collapsed: Cash as the one headline figure with its line,
 * four secondary figures beside it, then a definition line for the rest,
 * then the treasury memo as one line.
 */
export function KpiArea({ snapshot }: { snapshot: ConsoleSnapshot }) {
  const { kpis, series } = snapshot;
  const s = (pick: (row: ConsoleSnapshot["series"][number]) => number) => series.map(pick);
  const cash = s((r) => r.cashCents);
  const cashDelta = cash.length >= 2 ? cash[cash.length - 1]! - cash[0]! : 0;
  const first = series[0];
  const last = series[series.length - 1];
  const memo = kpis.memo;
  const realRate = kpis.baseRateBps - kpis.inflationRateBps;

  return (
    <>
      <section className="kpis" aria-label="Key figures" data-testid="kpi-strip">
        <div className="kpi-top">
          <div className="kpi-hero" data-testid="kpi-cash">
            <div className="kpi-hero-fig">
              <span className="lbl">Cash</span>
              <b className="big num">{money(kpis.cashCents)}</b>
              <span className="delta num">
                {cash.length < 2 ? (
                  "no history yet"
                ) : cashDelta === 0 ? (
                  `flat over ${cash.length} days`
                ) : (
                  <>
                    <b className={cashDelta > 0 ? "up" : undefined}>
                      {cashDelta > 0 ? "+" : "−"}
                      {money(Math.abs(cashDelta))}
                    </b>{" "}
                    over {cash.length} days
                  </>
                )}
              </span>
            </div>
            <div className="kpi-hero-line">
              <CashLine
                values={cash}
                label={
                  first && last
                    ? `Cash from day ${first.day} to day ${last.day}: ${money(first.cashCents)} to ${money(last.cashCents)}`
                    : "Cash history"
                }
              />
              <div className="spark-ax num" aria-hidden="true">
                <span>{first ? `Day ${first.day} · ${money(first.cashCents)}` : "Day 0"}</span>
                <span>{last ? `Day ${last.day}` : ""}</span>
              </div>
            </div>
          </div>
          <div className="quad">
            <div data-testid="kpi-loans">
              <span className="lbl">Loans outstanding</span>
              <b className="v num">{moneyShort(kpis.loansOutstandingCents)}</b>
              <span className="h">{kpis.loansTotal} loans ever</span>
            </div>
            <div data-testid="kpi-notes">
              <span className="lbl">Notes outstanding</span>
              <b className="v num">{moneyShort(kpis.notesOutstandingCents)}</b>
              <span className="h num">{deltaText(s((r) => r.notesCents), (n) => money(n))}</span>
            </div>
            <div data-testid="kpi-utilization">
              <span className="lbl">Utilization</span>
              <b className="v num">{pct(kpis.utilizationBps)}</b>
              <span className="h">loans ÷ (cash + loans)</span>
            </div>
            <div data-testid="kpi-reserve">
              <span className="lbl">Reserve ratio</span>
              <b className="v num">{pct(kpis.reserveRatioBps)}</b>
              <span className="h">cash ÷ notes outstanding</span>
            </div>
          </div>
        </div>
        <dl className="defl">
          <div data-testid="kpi-base-rate">
            <dt>Base rate</dt>
            <dd className="num">
              {pct(kpis.baseRateBps)} <span>· simulated walk</span>
            </dd>
          </div>
          <div data-testid="kpi-inflation">
            <dt>Inflation</dt>
            <dd className="num">
              {pct(kpis.inflationRateBps)} <span>· real rate {pct(realRate)}</span>
            </dd>
          </div>
          <div data-testid="kpi-allowance">
            <dt>CECL allowance</dt>
            <dd className="num">
              {moneyShort(kpis.allowanceCents)} <span>· gross of holder loss sharing</span>
            </dd>
          </div>
          <div data-testid="kpi-defaults">
            <dt>Defaults</dt>
            <dd className={`num${kpis.defaults > 0 ? " risk" : ""}`}>
              {kpis.defaults} <span>· charged off of {kpis.loansTotal} loans</span>
            </dd>
          </div>
        </dl>
      </section>
      <p className="memo" data-testid="treasury-headline">
        <span className="lbl" data-testid="kpi-memo-day">
          {memo ? `Treasury memo · Day ${memo.simDay}` : "Treasury memo"}
        </span>
        <span className="memo-text">
          {memo ? memo.headline : "No treasury memo yet — the treasury officer writes one each simulated day."}
        </span>
        {memo ? <span className="memo-src">{memo.source} · advisory</span> : null}
      </p>
    </>
  );
}
