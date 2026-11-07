"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import type { OwnerTimeline } from "@/server/services/timeline";

import { TIMELINE_LEGEND } from "./timeline-colors";

/** Bryntum is client-only: never server-rendered. */
const TimelineScheduler = dynamic(() => import("./timeline-scheduler"), {
  ssr: false,
  loading: () => (
    <div className="timeline-loading" aria-busy="true">
      Loading the timeline…
    </div>
  ),
});

const POLL_MS = 5000;

/**
 * P7 — the dashboard's Timeline tab: the owner's agents as rows, each loan
 * (disbursed → due) with the installments its agent planned, ladder steps,
 * repayments and the guarantee. Polls the owner-only
 * `/api/dashboard/timeline` every 5 s while the tab is visible.
 */
export function TimelinePanel({
  initial,
  worldId,
  licenseKey,
}: {
  initial: OwnerTimeline;
  worldId?: string;
  licenseKey: string | null;
}) {
  const [timeline, setTimeline] = useState(initial);
  const [narrow, setNarrow] = useState(false);
  const [updated, setUpdated] = useState<string | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const apply = () => setNarrow(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    let stopped = false;
    const url = `/api/dashboard/timeline${worldId ? `?world=${encodeURIComponent(worldId)}` : ""}`;
    async function poll() {
      if (document.visibilityState !== "visible") {
        return;
      }
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          return;
        }
        const body = (await res.json()) as { ok: boolean; timeline?: OwnerTimeline };
        if (!stopped && body.timeline) {
          setTimeline(body.timeline);
          setUpdated(new Date().toLocaleTimeString("en-US", { hour12: false }));
        }
      } catch {
        // Keep the last good data; the next poll retries.
      }
    }
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [worldId]);

  const installments = timeline.events.filter((e) => e.kind === "installment");
  const counts = {
    loans: timeline.events.filter((e) => e.kind === "loan").length,
    planned: installments.filter((e) => e.state === "planned").length,
    paid: installments.filter((e) => e.state === "paid").length,
    missed: installments.filter((e) => e.state === "missed").length + timeline.events.filter((e) => e.kind === "missed").length,
    failed: installments.filter((e) => e.state === "failed").length,
  };

  return (
    <section className="timeline" aria-labelledby="timeline-h" data-testid="timeline-panel">
      <div className="timeline-head">
        <div>
          <h2 id="timeline-h">Repayment timeline</h2>
          <p className="sub">
            Your agents plan their own installments and move them; the bank re-plans as PayPal payments land, miss or fail.
            You watch — nothing here can be dragged.
          </p>
        </div>
        <p className="timeline-meta num" aria-live="polite">
          Sim now {timeline.simNow.slice(0, 16).replace("T", " ")} · live{updated ? ` · ${updated}` : ""}
        </p>
      </div>
      <ul className="timeline-stats" aria-label="Schedule summary">
        <li><b className="num">{counts.loans}</b> loans</li>
        <li><b className="num">{counts.planned}</b> planned</li>
        <li><b className="num">{counts.paid}</b> paid</li>
        <li><b className="num">{counts.missed}</b> missed</li>
        <li><b className="num">{counts.failed}</b> failed</li>
      </ul>
      <TimelineScheduler timeline={timeline} licenseKey={licenseKey} narrow={narrow} />
      <ul className="timeline-legend" aria-label="Legend">
        {TIMELINE_LEGEND.map((item) => (
          <li key={item.label}>
            <i style={{ background: item.color }} aria-hidden="true" />
            {item.label}
          </li>
        ))}
      </ul>
    </section>
  );
}
