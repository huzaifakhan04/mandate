"use client";

import { useEffect, useRef, useState } from "react";

import { IconIn, IconOut } from "@/components/ui/icons";
import type { ConsoleSnapshot, FlowEdge } from "@/server/services/console";

import { logTime, money, statusLabel } from "./format";

/**
 * Money movements: the console's hero. One fused timeline built from the
 * PayPal API log (every call is a row, carrying its kind, HTTP status,
 * result and latency) and the flow's loan events (no PayPal call). Amounts
 * are from the bank's side; green only for money that came in.
 *
 * Signature move: a row that arrives with a poll gets `mv-new`, and its
 * amount settles in place once (300 ms fade-up inside a clipped cell, so
 * nothing shifts). Reduced motion: no animation.
 */

type Dir = "in" | "out" | "none";
type Row = {
  key: string;
  at: string;
  dir: Dir;
  event: string;
  detail: string | null;
  counterparty: string;
  call: { kind: string; http: number | null; status: string; ms: number | null } | null;
  amountCents: number | null;
  /** The money actually moved (a capture or a payout that succeeded). */
  moved: boolean;
  paypal: boolean;
};

const PURPOSE: Record<string, { event: string; who: string; dir: Dir }> = {
  note_purchase: { event: "Note purchase order opened", who: "Lender", dir: "in" },
  note_purchase_capture: { event: "Lender bought notes", who: "Lender", dir: "in" },
  loan_disbursement: { event: "Loan paid out to borrower", who: "Borrower", dir: "out" },
  repayment_link: { event: "Invoice sent to borrower's client", who: "Borrower's client", dir: "none" },
  repayment_capture: { event: "Client paid an invoice", who: "Borrower's client", dir: "in" },
  repayment_direct: { event: "Borrower repaid", who: "Borrower", dir: "in" },
  note_redemption: { event: "Notes cashed out", who: "Note holder", dir: "out" },
  remainder_payout: { event: "Invoice surplus paid to borrower", who: "Borrower", dir: "out" },
  guarantee: { event: "Owner guarantee charged", who: "Owner", dir: "in" },
  identity_verification: { event: "Owner identity checked", who: "Owner", dir: "none" },
  payout_cancel: { event: "Payout cancelled", who: "Borrower", dir: "none" },
};

const EVENT_TEXT: Record<FlowEdge, { event: string; who: string }> = {
  lend: { event: "Notes bought", who: "Lender" },
  disburse: { event: "Loan disbursed", who: "Borrower" },
  invoice: { event: "Invoice sent", who: "Borrower's client" },
  client_pay: { event: "Repayment received", who: "Borrower's client" },
  repay: { event: "Loan repaid", who: "Borrower" },
  redeem: { event: "Notes redeemed", who: "Note holder" },
};

const CAP = 12;

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildRows(snapshot: ConsoleSnapshot): Row[] {
  // A capture's request carries no amount; it inherits the order's.
  const byPaypalId = new Map<string, number>();
  for (const op of snapshot.paypalLog) {
    if (op.paypalId && op.amountCents !== null && !byPaypalId.has(op.paypalId)) {
      byPaypalId.set(op.paypalId, op.amountCents);
    }
  }
  const rows: Row[] = snapshot.paypalLog.map((op) => {
    const known = op.purpose ? PURPOSE[op.purpose] : undefined;
    const amountCents = op.amountCents ?? (op.paypalId ? (byPaypalId.get(op.paypalId) ?? null) : null);
    const moving = op.kind.endsWith(".capture") || op.kind === "payout.send";
    const event = known
      ? known.event
      : op.kind === "order.get"
        ? "Order status checked"
        : op.kind === "payout.get"
          ? "Payout status checked"
          : sentence(op.purpose ? statusLabel(op.purpose) : op.kind);
    return {
      key: `op:${op.id}`,
      at: op.at,
      dir: known && moving ? known.dir : "none",
      event,
      detail: op.rail === "paypal" ? "PayPal sandbox" : "sim rail",
      counterparty: known?.who ?? "PayPal",
      call: { kind: op.kind, http: op.httpStatus, status: op.status, ms: op.latencyMs },
      amountCents,
      moved: Boolean(known && moving && op.status === "succeeded"),
      paypal: true,
    };
  });
  for (const a of snapshot.flow.activity) {
    if (!a.key.startsWith("ev:")) {
      continue; // `op:` activity is the same call as a PayPal log row
    }
    const text = EVENT_TEXT[a.edge];
    rows.push({
      key: a.key,
      at: a.at,
      dir: "none",
      event: sentence(a.label),
      detail: null,
      counterparty: text.who,
      call: null,
      amountCents: null,
      moved: false,
      paypal: false,
    });
  }
  rows.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
  return rows;
}

function Glyph({ dir }: { dir: Dir }) {
  return (
    <span className={`gl ${dir}`} aria-hidden="true">
      {dir === "in" ? (
        <IconIn size={12} />
      ) : dir === "out" ? (
        <IconOut size={12} />
      ) : (
        <svg width="12" height="12" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="1.75" fill="currentColor" />
        </svg>
      )}
    </span>
  );
}

function Amount({ row }: { row: Row }) {
  if (row.amountCents === null) {
    return <span className="amt none">—</span>;
  }
  if (!row.moved) {
    return <span className="amt none num">{money(row.amountCents)}</span>;
  }
  return (
    <span className={`amt num${row.dir === "in" ? " in" : ""}`}>
      <span className="amt-v">
        {row.dir === "in" ? "+" : "−"}
        {money(row.amountCents)}
      </span>
    </span>
  );
}

type Filter = "all" | "in" | "out";

export function Movements({
  snapshot,
  ageSeconds,
  live,
  onOpenLog,
}: {
  snapshot: ConsoleSnapshot;
  ageSeconds: number;
  live: boolean;
  onOpenLog: () => void;
}) {
  const rows = buildRows(snapshot);
  const [filter, setFilter] = useState<Filter>("all");
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const keySig = rows.map((r) => r.key).join("|");

  // Rows that arrive with a poll settle in place once. The first render
  // only primes `seen`.
  useEffect(() => {
    const keys = keySig ? keySig.split("|") : [];
    if (seen.current === null) {
      seen.current = new Set(keys);
      return;
    }
    const added = keys.filter((k) => !seen.current!.has(k));
    for (const k of keys) {
      seen.current.add(k);
    }
    if (added.length === 0) {
      return;
    }
    setFresh(new Set(added));
    const timer = setTimeout(() => setFresh(new Set()), 1200);
    return () => clearTimeout(timer);
  }, [keySig]);

  const visible = rows.filter((r) => filter === "all" || (r.moved && r.dir === filter)).slice(0, CAP);

  return (
    <section className="moves" aria-labelledby="mv-h" data-testid="flow-ticker">
      <div className="sec-h">
        <h2 id="mv-h">Money movements</h2>
        <span className={`ui-st ${live ? "in" : "ring"}`}>
          <span className="num">updated {ageSeconds}s ago</span>
        </span>
        <div className="seg" role="group" aria-label="Show">
          {(["all", "in", "out"] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "in" ? "In" : "Out"}
            </button>
          ))}
        </div>
      </div>
      <div className="mvh" aria-hidden="true">
        <span>Time</span>
        <span />
        <span>Event</span>
        <span>Counterparty</span>
        <span>PayPal call</span>
        <span className="n">Amount</span>
      </div>
      <ul className="mvlist" aria-label="Latest money movements, newest first" data-testid="paypal-log">
        {visible.map((row) => (
          <li
            key={row.key}
            className={`mv${fresh.has(row.key) ? " mv-new" : ""}`}
            data-testid={row.paypal ? "paypal-log-row" : undefined}
          >
            <time className="tm" dateTime={row.at}>
              {logTime(row.at)}
            </time>
            <Glyph dir={row.moved ? row.dir : "none"} />
            <span className="ev">
              {row.event}
              {row.detail ? <span> · {row.detail}</span> : null}
            </span>
            <span className="cp">{row.counterparty}</span>
            {row.call ? (
              <span className="op">
                <b>{row.call.kind}</b>
                {row.call.http ? ` ${row.call.http}` : ""}{" "}
                <span className={row.call.status.startsWith("failed") ? "bad" : undefined}>{statusLabel(row.call.status)}</span>
                {row.call.ms !== null ? ` ${row.call.ms} ms` : ""}
              </span>
            ) : (
              <span className="op quiet">no PayPal call</span>
            )}
            <Amount row={row} />
          </li>
        ))}
        {rows.length === 0 ? <li className="mv-empty">No money has moved yet.</li> : null}
        {rows.length > 0 && visible.length === 0 ? <li className="mv-empty">Nothing in this view yet.</li> : null}
      </ul>
      <div className="mv-foot">
        <span>Amounts are from the bank&apos;s side; PayPal request bodies are redacted.</span>
        {snapshot.paypalLog.length > 0 ? (
          <button type="button" className="linkish" onClick={onOpenLog}>
            Showing {visible.length} of {rows.length} · Open the PayPal API log
          </button>
        ) : null}
      </div>
    </section>
  );
}
