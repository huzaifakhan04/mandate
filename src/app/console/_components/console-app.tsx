"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ConsoleSnapshot, ConsoleWorldChoice } from "@/server/services/console";

import { MoneyFlow } from "./flow";
import { ConsoleGrids } from "./grids";
import { RiskDesk } from "./risk";
import { logTime, money, moneyShort, pct, simDate, simTime, statusLabel, toneFor } from "./format";

export const POLL_MS = 2000;
const LEGAL = "Sandbox model · simulated money · notes are not deposits and not FDIC-insured";

type Choice = ConsoleWorldChoice;
type FeedState = "live" | "paused" | "error";

/** A 56×22 sparkline of `values` (flat line when there is nothing to show). */
function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) {
    return (
      <svg viewBox="0 0 56 22" aria-hidden="true">
        <path d="M0,11 L56,11" fill="none" stroke="#8a93a1" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const d = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 56;
      const y = max === min ? 11 : 19 - ((v - min) / span) * 16;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox="0 0 56 22" aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Kpi({
  label,
  value,
  sub,
  values,
  color,
  testId,
  risk = false,
}: {
  label: string;
  value: string;
  sub: string;
  values: number[];
  color: string;
  testId: string;
  risk?: boolean;
}) {
  return (
    <div className="k" data-testid={testId}>
      <span>{label}</span>
      <b className="num">{value}</b>
      <Sparkline values={values} color={color} />
      <small className={risk ? "risk" : undefined}>{sub}</small>
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

function opLine(op: ConsoleSnapshot["paypalLog"][number]): string {
  const purpose = op.purpose ? statusLabel(op.purpose) : "operation";
  return `${op.kind} ${purpose}`;
}

export function ConsoleApp({
  initial,
  worldParam,
  choices,
  licenseKey = null,
}: {
  initial: ConsoleSnapshot;
  /** `demo`, `main` or the private world's id — what the snapshot endpoint is polled with. */
  worldParam: string;
  choices: Choice[];
  /** P7: the Bryntum license key for the Calendar tab (null → trial). */
  licenseKey?: string | null;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [feed, setFeed] = useState<FeedState>("live");
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    try {
      const res = await fetch(`/api/console/snapshot?world=${encodeURIComponent(worldParam)}`, { cache: "no-store" });
      if (!res.ok) {
        setFeed("error");
        return;
      }
      const body = (await res.json()) as { ok: boolean; snapshot?: ConsoleSnapshot };
      if (body.ok && body.snapshot) {
        setSnapshot(body.snapshot);
        setFetchedAt(Date.now());
        setFeed("live");
      }
    } catch {
      setFeed("error");
    } finally {
      inFlight.current = false;
    }
  }, [worldParam]);

  // Poll every 2 s while the tab is visible; pause when hidden, refresh on return.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const loop = async () => {
      if (stopped) {
        return;
      }
      if (document.visibilityState === "visible") {
        await refresh();
        timer = setTimeout(loop, POLL_MS);
      }
    };
    const onVisibility = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") {
        void loop();
      } else {
        setFeed("paused");
      }
    };
    timer = setTimeout(loop, POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  // The bank clock ticks between polls at the world's speed.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // A clock message fades back to the live-feed status after a few seconds.
  useEffect(() => {
    if (!message || busy) {
      return;
    }
    const timer = setTimeout(() => setMessage(""), 4000);
    return () => clearTimeout(timer);
  }, [message, busy]);

  async function advance(days: 1 | 7) {
    setBusy(true);
    setMessage(`Advancing ${days === 1 ? "1 day" : "7 days"}…`);
    try {
      const res = await fetch(`/dashboard/worlds/${encodeURIComponent(worldParam)}/advance`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ days: String(days) }).toString(),
      });
      if (!res.ok) {
        setMessage("Could not move the clock.");
        return;
      }
      const body = (await res.json()) as { sim_day?: number };
      setMessage(`Clock moved to day ${body.sim_day ?? "?"}.`);
      await refresh();
    } catch {
      setMessage("Could not move the clock.");
    } finally {
      setBusy(false);
    }
  }

  const { kpis, series, clock, world } = snapshot;
  const sim = new Date(new Date(clock.simNow).getTime() + Math.max(0, now - fetchedAt) * clock.speed);
  const s = (pick: (row: ConsoleSnapshot["series"][number]) => number) => series.map(pick);
  const ageSeconds = Math.max(0, Math.round((now - fetchedAt) / 1000));
  const memo = kpis.memo;

  return (
    <div className="mc">
      <a className="skip" href="#console-main">
        Skip to content
      </a>
      <header className="top">
        <Link className="brand" href="/" aria-label="Mandate home">
          <i aria-hidden="true">M</i>Mandate <em>· Mission control</em>
        </Link>
        <div className="worldsw" data-testid="console-world-switcher">
          {choices.length > 1 ? (
            <form method="get" action="/console" className="worldsw">
              <label className="sr-only" htmlFor="console-world">
                World
              </label>
              <select
                id="console-world"
                name="world"
                defaultValue={worldParam}
                onChange={(e) => e.currentTarget.form?.requestSubmit()}
              >
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.kind === "private" ? `${c.name} · sandbox` : c.name}
                  </option>
                ))}
              </select>
              <noscript>
                <button type="submit" className="btn">
                  Go
                </button>
              </noscript>
            </form>
          ) : (
            <span className="static">{world.kind === "main" ? "Main world" : world.name}</span>
          )}
          {world.kind === "demo" ? (
            <span className="tag demo" data-testid="demo-badge" title="Simulated bots on a simulated rail — the clock moves a day every 10 minutes">
              Demo world · simulated money
            </span>
          ) : (
            <span className={`tag ${world.rail === "paypal" ? "sb" : "sim"}`}>{world.rail === "paypal" ? "PayPal sandbox" : "sim rail"}</span>
          )}
        </div>
        <div className="clock" data-testid="bank-clock">
          <span className="day" aria-label={`Bank clock: day ${clock.simDay}, ${simDate(sim)} ${simTime(sim)} UTC`}>
            <span className={`live-dot ${feed === "live" ? "" : feed === "paused" ? "paused" : "err"}`} aria-hidden="true" />
            <span className="num" data-testid="console-sim-day">
              Day {clock.simDay}
            </span>
            <small className="num">
              {simDate(sim)} · {simTime(sim)} UTC
            </small>
          </span>
          <span className="feed num" data-testid="clock-speed">
            {world.kind === "demo" ? "1 day / 10 min" : clock.speed > 0 ? `${clock.speed}× real time` : "manual clock"}
          </span>
          {world.kind === "private" ? (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => advance(1)} data-testid="advance-1">
                +1d
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => advance(7)} data-testid="advance-7">
                +7d
              </button>
            </>
          ) : null}
          <span className="feed" role="status" aria-live="polite" data-testid="feed-status">
            {message || (feed === "live" ? `live · ${ageSeconds}s ago` : feed === "paused" ? "paused (tab hidden)" : "reconnecting…")}
          </span>
        </div>
      </header>

      <main className="shell" id="console-main">
        <h1 className="sr-only">Mandate bank console — {world.kind === "main" ? "main world" : world.name}</h1>
        {world.kind === "demo" ? (
          <p className="demo-note" data-testid="demo-note">
            You are watching the <b>demo world</b>: simulated lender and borrower bots on a simulated rail, one bank day every
            10 minutes, with a mild stress event every third day. Nothing here touches PayPal.{" "}
            <Link href="/console?world=main">Switch to the main world (real PayPal sandbox)</Link>.
          </p>
        ) : null}
        <section className="kstrip" aria-label="Key figures" data-testid="kpi-strip">
          <Kpi
            testId="kpi-cash"
            label="Cash"
            value={moneyShort(kpis.cashCents)}
            sub={deltaText(s((r) => r.cashCents), (n) => money(n))}
            values={s((r) => r.cashCents)}
            color="#0f9d58"
          />
          <Kpi
            testId="kpi-loans"
            label="Loans outstanding"
            value={moneyShort(kpis.loansOutstandingCents)}
            sub={`${kpis.loansTotal} loans ever`}
            values={s((r) => r.loansCents)}
            color="#1d4ed8"
          />
          <Kpi
            testId="kpi-notes"
            label="Notes outstanding"
            value={moneyShort(kpis.notesOutstandingCents)}
            sub={deltaText(s((r) => r.notesCents), (n) => money(n))}
            values={s((r) => r.notesCents)}
            color="#0f9d58"
          />
          <Kpi
            testId="kpi-utilization"
            label="Utilization"
            value={pct(kpis.utilizationBps)}
            sub="loans ÷ (cash + loans)"
            values={s((r) => r.utilizationBps)}
            color="#1d4ed8"
          />
          <Kpi
            testId="kpi-base-rate"
            label="Base rate"
            value={pct(kpis.baseRateBps)}
            sub="simulated walk"
            values={s((r) => r.baseRateBps)}
            color="#8a93a1"
          />
          <Kpi
            testId="kpi-inflation"
            label="Inflation"
            value={pct(kpis.inflationRateBps)}
            sub={`real rate ${pct(kpis.baseRateBps - kpis.inflationRateBps)}`}
            values={s((r) => r.inflationRateBps)}
            color="#8a93a1"
          />
          <Kpi
            testId="kpi-reserve"
            label="Reserve ratio"
            value={pct(kpis.reserveRatioBps)}
            sub="cash ÷ notes outstanding"
            values={s((r) => r.reserveRatioBps)}
            color="#0f9d58"
          />
          <Kpi
            testId="kpi-allowance"
            label="Allowance (CECL)"
            value={moneyShort(kpis.allowanceCents)}
            sub="gross of holder loss sharing"
            values={s((r) => r.allowanceCents)}
            color="#b26a00"
          />
          <Kpi
            testId="kpi-defaults"
            label="Defaults"
            value={String(kpis.defaults)}
            sub={`charged off of ${kpis.loansTotal} loans`}
            values={s((r) => r.defaults)}
            color="#d93025"
            risk={kpis.defaults > 0}
          />
          <Kpi
            testId="kpi-memo-day"
            label="Treasury memo"
            value={memo ? `Day ${memo.simDay}` : "—"}
            sub={memo ? `${memo.source} · advisory` : "written daily"}
            values={[]}
            color="#8a93a1"
          />
        </section>
        <div className="memo" data-testid="treasury-headline">
          <b>Treasury memo</b>
          <p>{memo ? memo.headline : "No treasury memo yet — the treasury officer writes one each simulated day."}</p>
          {memo ? <small>day {memo.simDay}</small> : null}
        </div>

        <div className="duo">
          <section className="panel" aria-labelledby="flow-h">
            <div className="ph">
              <h2 id="flow-h">Money flow</h2>
              <span className="pill blue">live</span>
              <span className="r">green into the bank · blue out · purple invoices</span>
            </div>
            <div className="pb flow-wrap">
              <MoneyFlow snapshot={snapshot} />
            </div>
          </section>
          <section className="panel logpanel" aria-labelledby="log-h">
            <div className="ph">
              <span className={`live-dot ${feed === "live" ? "" : feed === "paused" ? "paused" : "err"}`} aria-hidden="true" />
              <h2 id="log-h">PayPal API log</h2>
              <span className="r">latest {snapshot.paypalLog.length} · bodies redacted</span>
            </div>
            <div className="pb" tabIndex={0} aria-label="PayPal API log, newest first">
              {snapshot.paypalLog.length === 0 ? (
                <p className="empty">No PayPal operations yet.</p>
              ) : (
                <ul className="log" data-testid="paypal-log">
                  {snapshot.paypalLog.map((op) => (
                    <li key={op.id} data-testid="paypal-log-row">
                      <time className="num" dateTime={op.at}>
                        {logTime(op.at)}
                      </time>
                      <span className="line">
                        <span className="m">{opLine(op)}</span>
                        {op.httpStatus ? <span className="ref"> → {op.httpStatus}</span> : null}
                        {op.amountCents !== null ? <span className="ref"> · {money(op.amountCents)}</span> : null}
                        {op.paypalId ? <span className="ref"> · {op.paypalId}</span> : null}
                      </span>
                      <span className="meta">
                        <span className={`pill ${toneFor(op.status)}`}>{statusLabel(op.status)}</span>
                        {op.latencyMs !== null ? <span className="ref num">{op.latencyMs} ms</span> : null}
                        <span className={`tag ${op.rail === "paypal" ? "sb" : "sim"}`}>{op.rail === "paypal" ? "sandbox" : "simulated"}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        <RiskDesk snapshot={snapshot} worldParam={worldParam} />

        <ConsoleGrids snapshot={snapshot} worldParam={worldParam} licenseKey={licenseKey} />

        <footer className="legal">
          {LEGAL} · <Link href="/agents.md">agents.md</Link> · updated {logTime(snapshot.generatedAt)} UTC
        </footer>
      </main>
    </div>
  );
}
