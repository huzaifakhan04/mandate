/** Display helpers for the console (client-safe: plain numbers, no bigint). */

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const USD_COMPACT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** `12345` → `"$123.45"`. */
export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) {
    return "—";
  }
  return USD.format(cents / 100);
}

/** `1234500` → `"$12,345"` (whole dollars, for the KPI strip). */
export function moneyShort(cents: number): string {
  return Math.abs(cents) >= 1_000_000 ? USD_COMPACT.format(cents / 100) : USD.format(cents / 100);
}

/** Basis points as a percent with 2 decimals: `410` → `"4.10%"`. */
export function pct(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) {
    return "—";
  }
  return `${(bps / 100).toFixed(2)}%`;
}

const SIM_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const SIM_TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
const LOG_TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

export function simDate(date: Date): string {
  return SIM_DATE.format(date);
}
export function simTime(date: Date): string {
  return SIM_TIME.format(date);
}
export function logTime(iso: string): string {
  return LOG_TIME.format(new Date(iso));
}
export function shortDate(iso: string): string {
  return SIM_DATE.format(new Date(iso));
}

export type Tone = "ok" | "warn" | "risk" | "blue" | "grey";

const STATUS_TONE: Record<string, Tone> = {
  // loans
  active: "ok",
  repaid: "grey",
  accepted: "blue",
  disbursing: "blue",
  late: "warn",
  substandard: "risk",
  charged_off: "risk",
  recovered: "grey",
  disbursement_failed: "risk",
  // paypal operations
  succeeded: "ok",
  queued: "blue",
  in_flight: "blue",
  failed_retryable: "warn",
  failed_terminal: "risk",
  // agents
  pending: "warn",
  restricted: "warn",
  frozen: "risk",
  revoked: "grey",
  closed: "grey",
};

export function toneFor(status: string): Tone {
  return STATUS_TONE[status] ?? "grey";
}

export function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}
