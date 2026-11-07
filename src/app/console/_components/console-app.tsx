"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { MandateLogo } from "@/components/brand/MandateLogo";
import {
  IconAgent,
  IconBox,
  IconCalendar,
  IconCode,
  IconConsole,
  IconDoc,
  IconLedger,
  IconLoan,
  IconNote,
  IconShield,
  IconTimeline,
} from "@/components/ui/icons";
import { LEGAL } from "@/components/ui/legal";
import type { ConsoleSnapshot, ConsoleWorldChoice } from "@/server/services/console";

import { MoneyFlow } from "./flow";
import { logTime, simDate, simTime } from "./format";
import { ConsoleGrids, type TabId } from "./grids";
import { KpiArea } from "./kpis";
import { Movements } from "./movements";

export const POLL_MS = 2000;

type Choice = ConsoleWorldChoice;
type FeedState = "live" | "paused" | "error";

const NAV: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: "ledger", label: "Ledger", icon: <IconLedger size={16} /> },
  { id: "loans", label: "Loans", icon: <IconLoan size={16} /> },
  { id: "notes", label: "Notes", icon: <IconNote size={16} /> },
  { id: "agents", label: "Agents", icon: <IconAgent size={16} /> },
  { id: "risk", label: "Risk desk", icon: <IconShield size={16} /> },
  { id: "calendar", label: "Calendar", icon: <IconCalendar size={16} /> },
  { id: "paypal", label: "Logs", icon: <IconTimeline size={16} /> },
];

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
  const [tab, setTab] = useState<TabId>("ledger");
  const inFlight = useRef(false);
  const recordsRef = useRef<HTMLDivElement>(null);

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

  function openTab(id: TabId) {
    setTab(id);
    recordsRef.current?.scrollIntoView({ block: "start" });
  }

  const { clock, world } = snapshot;
  const sim = new Date(new Date(clock.simNow).getTime() + Math.max(0, now - fetchedAt) * clock.speed);
  const ageSeconds = Math.max(0, Math.round((now - fetchedAt) / 1000));
  const simulated = world.kind === "demo" || world.rail === "sim";
  const counts: Partial<Record<TabId, number>> = {
    ledger: snapshot.ledgerEntries,
    loans: snapshot.loans.length,
    notes: snapshot.notes.length,
    agents: snapshot.agents.length,
    risk: snapshot.risk.open,
    paypal: snapshot.paypalLog.length,
  };
  const feedTone = feed === "live" ? "in" : feed === "paused" ? "ring" : "risk";

  return (
    <div className="shell mc">
      <a className="skip" href="#console-main">
        Skip to content
      </a>
      <aside className="shell-side" aria-label="Console">
        <Link className="shell-brand" href="/" aria-label="Mandate home">
          <MandateLogo size={16} />
        </Link>
        <div className="shell-world" data-testid="console-world-switcher">
          {choices.length > 1 ? (
            <form method="get" action="/console">
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
                <button type="submit" className="ui-btn">
                  Go
                </button>
              </noscript>
            </form>
          ) : (
            <span className="world-static">{world.kind === "main" ? "Main world" : world.name}</span>
          )}
          <div className="world-meta">
            {simulated && world.kind !== "demo" ? <span className="ui-tag sim">Simulated</span> : null}
            {world.kind === "demo" ? null : (
              <span className={simulated ? "world-rail" : "ui-tag"}>{world.rail === "paypal" ? "PayPal sandbox" : "sim rail"}</span>
            )}
          </div>
        </div>
        <nav className="shell-nav" aria-label="Console sections">
          <a href="#console-main" aria-current="page">
            <IconConsole size={16} />
            Console
          </a>
          {NAV.map((n) => (
            <button key={n.id} type="button" onClick={() => openTab(n.id)}>
              {n.icon}
              {n.label}
              {counts[n.id] !== undefined ? <span className="count">{counts[n.id]!.toLocaleString("en-US")}</span> : null}
            </button>
          ))}
        </nav>
        <div className="shell-foot">
          <div className="shell-sec">Developers</div>
          <nav className="shell-nav" aria-label="Developers">
            <a href="/agents.md">
              <IconDoc size={16} />
              agents.md
            </a>
            <a href="/openapi.json">
              <IconCode size={16} />
              OpenAPI
            </a>
            <Link href="/sdks">
              <IconBox size={16} />
              SDKs
            </Link>
          </nav>
        </div>
      </aside>

      <div className="shell-main">
        <header className="shell-head">
          <span className="crumb">Mission control</span>
          {world.kind === "demo" ? (
            <span
              className="ui-tag sim"
              data-testid="demo-badge"
              title="Simulated bots on a simulated rail — the clock moves a day every 10 minutes"
            >
              Demo world · simulated money
            </span>
          ) : null}
          <span className="grow" />
          <div className="clock" data-testid="bank-clock">
            <span className="day" aria-label={`Bank clock: day ${clock.simDay}, ${simDate(sim)} ${simTime(sim)} UTC`}>
              <b className="num" data-testid="console-sim-day">
                Day {clock.simDay}
              </b>
              <span className="num when">
                {simDate(sim)} {simTime(sim)} UTC
              </span>
            </span>
            <span className="sep" aria-hidden="true" />
            <span className="num speed" data-testid="clock-speed">
              {world.kind === "demo" ? "1 day / 10 min" : clock.speed > 0 ? `${clock.speed}× real time` : "manual clock"}
            </span>
            {world.kind === "private" ? (
              <>
                <button type="button" className="ui-btn" disabled={busy} onClick={() => advance(1)} data-testid="advance-1">
                  +1 day
                </button>
                <button type="button" className="ui-btn" disabled={busy} onClick={() => advance(7)} data-testid="advance-7">
                  +7 days
                </button>
              </>
            ) : null}
            <span className={`ui-st ${feedTone} feed`} role="status" aria-live="polite" data-testid="feed-status">
              {message ||
                (feed === "live" ? `live · updated ${ageSeconds}s ago` : feed === "paused" ? "paused (tab hidden)" : "reconnecting…")}
            </span>
          </div>
        </header>

        <main className="shell-body" id="console-main">
          <h1 className="sr-only">Mandate bank console — {world.kind === "main" ? "main world" : world.name}</h1>
          {world.kind === "demo" ? (
            <p className="world-line" data-testid="demo-note">
              <span className="ui-st sim" aria-hidden="true" />
              <span>
                You are watching the demo world: simulated lender and borrower bots on a simulated rail, one bank day every 10
                minutes, with a mild stress event every third day. Nothing here touches PayPal.{" "}
                <Link href="/console?world=main">Switch to the main world (real PayPal sandbox)</Link>
              </span>
            </p>
          ) : null}

          <KpiArea snapshot={snapshot} />

          <MoneyFlow snapshot={snapshot} />

          <Movements snapshot={snapshot} ageSeconds={ageSeconds} live={feed === "live"} onOpenLog={() => openTab("paypal")} />

          <div ref={recordsRef} className="records">
            <ConsoleGrids snapshot={snapshot} worldParam={worldParam} licenseKey={licenseKey} tab={tab} onTab={setTab} />
          </div>

          <footer className="legal">
            <span>{LEGAL}</span>
            <a href="/agents.md">agents.md</a>
            <span className="num">updated {logTime(snapshot.generatedAt)} UTC</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
