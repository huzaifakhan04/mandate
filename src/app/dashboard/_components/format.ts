/** Display helpers for the owner dashboard. Money arrives as bigint cents. */

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** `12345n` → `"$123.45"`. Exact for any bigint (no float rounding). */
export function formatCents(cents: bigint | number): string {
  const value = BigInt(cents);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const dollars = abs / 100n;
  const rest = (abs % 100n).toString().padStart(2, "0");
  const whole = USD.format(Number(dollars)).replace(/\.00$/, "");
  return `${negative ? "-" : ""}${whole}.${rest}`;
}

/** Cents as a plain dollar amount for an input's value: `30000n` → `"300"`, `12345n` → `"123.45"`. */
export function centsInputValue(cents: bigint): string {
  const rest = cents % 100n;
  return rest === 0n ? (cents / 100n).toString() : `${cents / 100n}.${rest.toString().padStart(2, "0")}`;
}

/** Basis points as a percent: `300` → `"3%"`, `250` → `"2.5%"`. */
export function formatBps(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

export function formatDate(date: Date): string {
  return DATE.format(date);
}

export function formatDateTime(date: Date): string {
  return `${DATE_TIME.format(date)} UTC`;
}

/** Up to two initials: "Studio LLC" → "SL". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0]![0]! + parts[parts.length - 1]![0]! : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** A short id for display: the first 8 hex characters of a uuid. */
export function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}

/** A loan's short display label, e.g. `L-3F9A1C`. */
export function loanLabel(id: string): string {
  return `L-${shortId(id).slice(0, 6).toUpperCase()}`;
}
