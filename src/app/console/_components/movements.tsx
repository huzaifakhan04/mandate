"use client";

import { useEffect, useRef, useState } from "react";

import { IconIn, IconOut } from "@/components/ui/icons";
import type { ConsoleSnapshot, FlowEdge } from "@/server/services/console";

import { logTime, money, statusLabel } from "./format";

/**
 * Money movements: the console's hero. One fused timeline built from the
 * PayPal API log (one row per order or payout, carrying the call chain,
 * HTTP status, result and latency of the call that moved the money) and the
 * flow's loan events (no PayPal call). Amounts
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
  call: { kind: string; http: number | null; status: string; ms: number | null; chain: string[] } | null;
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
  // One row per money movement: the calls behind one PayPal order or payout
  // (create, status checks, capture) fold into the row of the call that
  // moved the money, and the chain shows in the PayPal call column. The
  // full call-by-call record stays in the Logs tab.
  const isMoving = (kind: string) => kind.endsWith(".capture") || kind === "payout.send";
  const groups = new Map<string, ConsoleSnapshot["paypalLog"]>();
  for (const op of snapshot.paypalLog) {
    const key = op.paypalId ? `pp:${op.paypalId}` : `op:${op.id}`;
    const list = groups.get(key);
    if (list) list.push(op);
    else groups.set(key, [op]);
  }
  const rows: Row[] = [];
  for (const ops of groups.values()) {
    // Newest first within the group, like the log.
    const lead = ops.find((o) => isMoving(o.kind)) ?? ops[0];
    if (!lead) continue;
    // Oldest first, repeated status checks shown once: "order.create · order.get · order.capture".
    const chain = [...ops].reverse().map((o) => o.kind).filter((k, i, all) => k !== all[i - 1]);
    const purposeOp = ops.find((o) => o.purpose && PURPOSE[o.purpose] && isMoving(o.kind)) ?? ops.find((o) => o.purpose && PURPOSE[o.purpose]);
    const known = purposeOp?.purpose ? PURPOSE[purposeOp.purpose] : undefined;
    const moving = isMoving(lead.kind);
    const amountCents = ops.find((o) => o.amountCents !== null)?.amountCents ?? null;
    const event = known
      ? moving && purposeOp?.purpose === "note_purchase"
        ? "Lender bought notes"
        : known.event
      : lead.kind === "order.get"
        ? "Order status checked"
        : lead.kind === "payout.get"
          ? "Payout status checked"
          : sentence(lead.purpose ? statusLabel(lead.purpose) : lead.kind);
    const moved = Boolean(known && moving && lead.status === "succeeded");
    rows.push({
      key: `op:${lead.id}`,
      at: lead.at,
      dir: known && moving ? known.dir : "none",
      event,
      detail: lead.rail === "paypal" ? "PayPal sandbox" : "sim rail",
      counterparty: known?.who ?? "PayPal",
      call: {
        kind: lead.kind,
        chain,
        http: lead.httpStatus,
        status: lead.status,
        ms: lead.latencyMs,
      },
      // Only money that actually moved carries an amount.
      amountCents: moved ? amountCents : null,
      moved,
      paypal: true,
    });
  }
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
              <span className="op" title={row.call.chain.length > 1 ? row.call.chain.join(" → ") : undefined}>
                <b>{row.call.kind}</b>
                {row.call.http ? ` ${row.call.http}` : ""}{" "}
                <span className={row.call.status.startsWith("failed") ? "bad" : undefined}>{statusLabel(row.call.status)}</span>
                {row.call.ms !== null ? ` ${row.call.ms} ms` : ""}
                {row.call.chain.length > 1 ? <span className="calls"> · {row.call.chain.length} calls</span> : null}
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
            Showing {visible.length} of {rows.length} · Open the logs
          </button>
        ) : null}
      </div>
    </section>
  );
}
