"use client";

/*
 * P7 — the console's Calendar tab, a Bryntum Calendar (8.x) in month / week /
 * agenda modes. Client-only: loaded by calendar-panel.tsx with
 * `next/dynamic` + `ssr: false`. Read-only.
 */
import "@bryntum/core-enterprise/fontawesome/css/fontawesome.css";
import "@bryntum/core-enterprise/fontawesome/css/solid.css";
import "@bryntum/calendar-enterprise/calendar.css";
import "@bryntum/calendar-enterprise/svalbard-dark.css";
import "../../_bryntum/theme.css";

import { BryntumCalendar } from "@bryntum/calendar-react-enterprise";
import type { EventModel, EventModelConfig, ResourceModelConfig } from "@bryntum/calendar-enterprise";
import { StringHelper } from "@bryntum/core-enterprise";
import { useMemo, useState } from "react";

import type { ConsoleCalendar } from "@/server/services/timeline";

import { applyBryntumLicense } from "../../_bryntum/license";
import { CALENDARS, INSTALLMENT_STATE_COLOR } from "./calendar-colors";

/**
 * All-day events arrive as UTC sim days; the Calendar lays days out in the
 * viewer's local time zone, so an all-day event is placed on the same
 * calendar date at local midnight (otherwise a UTC day straddles two local days).
 */
function localDay(iso: string): Date {
  const at = new Date(iso);
  return new Date(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

function detailOf(record: EventModel): string[] {
  const data = (record as unknown as { originalData?: { detail?: string[] } }).originalData;
  return data?.detail ?? [record.name];
}

export default function CalendarView({
  calendar,
  licenseKey,
  narrow,
}: {
  calendar: ConsoleCalendar;
  licenseKey: string | null;
  narrow: boolean;
}) {
  applyBryntumLicense(licenseKey);

  const [date] = useState(() => localDay(calendar.simNow));
  const resources = useMemo(() => CALENDARS.map((c) => ({ ...c }) as ResourceModelConfig), []);
  const events = useMemo(
    () =>
      calendar.events.map(
        (e) =>
          ({
            id: e.id,
            resourceId: e.calendar,
            name: e.name,
            startDate: e.allDay ? localDay(e.startDate) : new Date(e.startDate),
            endDate: e.allDay ? localDay(e.endDate) : new Date(e.endDate),
            allDay: e.allDay,
            ...(e.calendar === "installment" ? { eventColor: INSTALLMENT_STATE_COLOR[e.state] } : {}),
            cls: `cal-${e.calendar} cal-${e.state}`,
            detail: e.detail,
          }) as unknown as EventModelConfig,
      ),
    [calendar.events],
  );

  return (
    <div className="bry-host" style={{ height: narrow ? 560 : 620 }} data-testid="console-calendar">
      <BryntumCalendar
        date={date}
        tier="business"
        readOnly
        mode={narrow ? "agenda" : "month"}
        modes={{ day: null, year: null, month: true, week: true, agenda: true }}
        // A boolean only: a sidebar config object here throws during Calendar construction (8.0.0).
        sidebar={!narrow}
        dragFeature={false}
        eventEditFeature={false}
        eventMenuFeature={false}
        scheduleMenuFeature={false}
        eventTooltipFeature={{
          renderer: async ({ eventRecord }: { eventRecord: EventModel }) =>
            detailOf(eventRecord)
              .map((line, i) => (i === 0 ? `<b>${StringHelper.encodeHtml(line)}</b>` : `<span>${StringHelper.encodeHtml(line)}</span>`))
              .join(""),
        }}
        resources={resources}
        events={events}
      />

    </div>
  );
}
