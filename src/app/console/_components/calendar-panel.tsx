"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import type { ConsoleCalendar } from "@/server/services/timeline";

import { CALENDARS } from "./calendar-colors";

/** Bryntum is client-only: never server-rendered. */
const CalendarView = dynamic(() => import("./calendar-view"), {
  ssr: false,
  loading: () => (
    <p className="empty" aria-busy="true">
      Loading the calendar…
    </p>
  ),
});

const POLL_MS = 10_000;

/**
 * P7 — the console's Calendar tab: loan due dates, the installments agents
 * planned for themselves, treasury memos, queued redemptions and stress
 * events for the selected world, from `/api/console/calendar` (same world
 * and PII rules as the snapshot), refreshed every 10 s while visible.
 */
export function CalendarPanel({ worldParam, licenseKey }: { worldParam: string; licenseKey: string | null }) {
  const [calendar, setCalendar] = useState<ConsoleCalendar | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const apply = () => setNarrow(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    let stopped = false;
    async function load() {
      if (document.visibilityState !== "visible") {
        return;
      }
      try {
        const res = await fetch(`/api/console/calendar?world=${encodeURIComponent(worldParam)}`, { cache: "no-store" });
        const body = (await res.json()) as { ok: boolean; calendar?: ConsoleCalendar; message?: string };
        if (stopped) {
          return;
        }
        if (body.calendar) {
          setCalendar(body.calendar);
          setError(null);
        } else {
          setError(body.message ?? "Could not load the calendar.");
        }
      } catch {
        if (!stopped) {
          setError("Could not load the calendar; retrying.");
        }
      }
    }
    void load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [worldParam]);

  return (
    <div className="calpanel" data-testid="calendar-panel">
      <ul className="cal-legend" aria-label="Calendars">
        {CALENDARS.map((c) => (
          <li key={c.id}>
            <i style={{ background: c.eventColor }} aria-hidden="true" />
            {c.name}
            <small className="num">{calendar ? calendar.events.filter((e) => e.calendar === c.id).length : "…"}</small>
          </li>
        ))}
      </ul>
      {error && !calendar ? <p className="empty">{error}</p> : null}
      {calendar ? <CalendarView calendar={calendar} licenseKey={licenseKey} narrow={narrow} /> : null}
    </div>
  );
}
