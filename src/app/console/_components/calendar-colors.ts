import type { CalendarKind } from "@/server/services/timeline";

/** P7 — the console Calendar's calendars (Bryntum resources), coloured from the light tokens. */
export const CALENDARS: Array<{ id: CalendarKind; name: string; eventColor: string }> = [
  { id: "due", name: "Loan due dates", eventColor: "#1d4ed8" },
  { id: "installment", name: "Agent installments", eventColor: "#0f9d58" },
  { id: "memo", name: "Treasury memos", eventColor: "#6b3fb3" },
  { id: "redemption", name: "Queued redemptions", eventColor: "#b26a00" },
  { id: "stress", name: "Stress events", eventColor: "#d93025" },
];

/** An installment's own state colour wins over its calendar's. */
export const INSTALLMENT_STATE_COLOR: Record<string, string> = {
  planned: "#1d4ed8",
  paid: "#0f9d58",
  missed: "#b26a00",
  failed: "#d93025",
};
