"use client";

/*
 * P7 — the owner Timeline, a Bryntum Scheduler (8.x). Client-only: loaded
 * by timeline-panel.tsx with `next/dynamic` + `ssr: false` (Bryntum can't
 * render on the server). Read-only — owners watch, the agent drives the
 * schedule (plan_repayments / reschedule_installment) and the bank's tick
 * re-plans it from payment events.
 */
import "@bryntum/core-enterprise/fontawesome/css/fontawesome.css";
import "@bryntum/core-enterprise/fontawesome/css/solid.css";
import "@bryntum/scheduler-enterprise/scheduler.css";
import "@bryntum/scheduler-enterprise/svalbard-dark.css";
import "../../_bryntum/theme.css";

import { StringHelper } from "@bryntum/core-enterprise";
import { BryntumScheduler } from "@bryntum/scheduler-react-enterprise";
import type {
  EventModel,
  EventModelConfig,
  ResourceModelConfig,
  ResourceTimeRangeModelConfig,
  TimeSpanConfig,
} from "@bryntum/scheduler-enterprise";
import { useMemo, useState } from "react";

import type { OwnerTimeline, TimelineEvent } from "@/server/services/timeline";

import { applyBryntumLicense } from "../../_bryntum/license";
import { timelineColor } from "./timeline-colors";

const DAY_MS = 86_400_000;

function tooltipHtml(detail: string[]): string {
  const [head, ...rest] = detail;
  return `<div class="bry-tip"><b>${StringHelper.encodeHtml(head ?? "")}</b>${rest
    .map((line) => `<span>${StringHelper.encodeHtml(line)}</span>`)
    .join("")}</div>`;
}

function detailOf(record: EventModel): string[] {
  const data = (record as unknown as { originalData?: { detail?: string[] } }).originalData;
  return data?.detail ?? [record.name];
}

export default function TimelineScheduler({
  timeline,
  licenseKey,
  narrow,
}: {
  timeline: OwnerTimeline;
  licenseKey: string | null;
  narrow: boolean;
}) {
  applyBryntumLicense(licenseKey);

  const simNow = new Date(timeline.simNow);
  // Each loan is a shaded band in its agent's row (disbursed → due) plus a "Due" milestone that
  // carries its tooltip; everything else — installments, misses, ladder steps, repayments, the
  // guarantee — is a milestone stacked in lanes under it.
  const { events, bands } = useMemo(() => {
    const milestones: EventModelConfig[] = [];
    const loanBands: ResourceTimeRangeModelConfig[] = [];
    for (const e of timeline.events as TimelineEvent[]) {
      const color = timelineColor(e.kind, e.state);
      if (e.kind === "loan") {
        loanBands.push({
          id: `band:${e.id}`,
          resourceId: e.resourceId,
          name: e.name,
          startDate: new Date(e.startDate),
          endDate: new Date(e.endDate),
          cls: `tl-band tl-band-${e.state}`,
        });
      }
      const at = e.kind === "loan" ? new Date(e.endDate) : new Date(e.startDate);
      milestones.push({
        id: e.id,
        resourceId: e.resourceId,
        name: e.kind === "loan" ? `Due · ${e.name}` : e.name,
        startDate: at,
        endDate: at,
        eventColor: color,
        cls: `tl-${e.kind} tl-${e.state}`,
        detail: e.detail,
      } as unknown as EventModelConfig);
    }
    return { events: milestones, bands: loanBands };
  }, [timeline.events]);
  const resources = useMemo(
    () => timeline.resources.map((r) => ({ id: r.id, name: r.name }) as ResourceModelConfig),
    [timeline.resources],
  );
  const timeRanges = useMemo(
    () => [{ id: "sim-now", name: "Sim now", startDate: simNow, duration: 0 } as TimeSpanConfig],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the ISO string
    [timeline.simNow],
  );

  // The visible window is fixed at mount (live polls refresh the data, not the scroll position).
  const [range] = useState(() => {
    const times = timeline.events.flatMap((e) => [Date.parse(e.startDate), Date.parse(e.endDate)]);
    const from = Math.min(simNow.getTime() - 3 * DAY_MS, ...times);
    const to = Math.max(simNow.getTime() + 21 * DAY_MS, ...times);
    return { startDate: new Date(from - DAY_MS), endDate: new Date(to + 2 * DAY_MS) };
  });

  return (
    <div
      className="bry-host"
      style={{ height: Math.min(600, Math.max(260, 120 + timeline.resources.length * 140)) }}
      data-testid="timeline-scheduler"
    >
      <BryntumScheduler
        tier="business"
        readOnly
        startDate={range.startDate}
        endDate={range.endDate}
        viewPreset={narrow ? "weekAndMonth" : "weekAndDayLetter"}
        rowHeight={34}
        barMargin={5}
        eventStyle="filled"
        eventLayout="stack"
        milestoneLayoutMode="estimate"
        milestoneTextPosition="always-outside"
        milestoneAlign="center"
        columns={[{ text: "Agent", field: "name", width: narrow ? 96 : 170 }]}
        resources={resources}
        events={events}
        timeRanges={timeRanges}
        resourceTimeRanges={bands}
        resourceTimeRangesFeature
        timeRangesFeature={{ showHeaderElements: true }}
        eventTooltipFeature={{ template: ({ eventRecord }: { eventRecord: EventModel }) => tooltipHtml(detailOf(eventRecord)) }}
        eventDragFeature={false}
        eventResizeFeature={false}
        eventDragCreateFeature={false}
        eventEditFeature={false}
        eventMenuFeature={false}
        scheduleMenuFeature={false}
        cellMenuFeature={false}
        zoomOnMouseWheel={false}
        emptyText="No agents in this view yet."
        eventRenderer={({ eventRecord }: { eventRecord: EventModel }) => StringHelper.encodeHtml(eventRecord.name)}
      />
    </div>
  );
}
