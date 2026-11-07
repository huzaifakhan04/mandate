import type { CalendarKind } from "@/server/services/timeline";

/** P7 — the console Calendar's calendars (Bryntum resources), coloured from the dark tokens in globals.css. */
export const CALENDARS: Array<{ id: CalendarKind; name: string; eventColor: string }> = [
  { id: "due", name: "Loan due dates", eventColor: "#7f86e0" },
  { id: "installment", name: "Agent installments", eventColor: "#5cb88a" },
  { id: "memo", name: "Treasury memos", eventColor: "#a59bd9" },
  { id: "redemption", name: "Queued redemptions", eventColor: "#d6a24a" },
  { id: "stress", name: "Stress events", eventColor: "#e5675e" },
];

/** An installment's own state colour wins over its calendar's. */
export const INSTALLMENT_STATE_COLOR: Record<string, string> = {
  planned: "#7f86e0",
  paid: "#5cb88a",
  missed: "#d6a24a",
  failed: "#e5675e",
};
