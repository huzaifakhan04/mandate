"use client";

import { useEffect, useRef, useState } from "react";

import type { ConsoleSnapshot, FlowEdge } from "@/server/services/console";

import { money, pct } from "./format";

/**
 * The money flow as a compact strip: lenders → bank pool → borrowers →
 * invoice payers. Nodes are text with figures; the connectors are hairlines
 * carrying the latest movement on each lane. A lane with a NEW movement since
 * the last poll lights up for a moment (a state change, so it may move;
 * reduced motion keeps the highlight and drops the transition).
 */

const LANE_LABEL: Record<FlowEdge, string> = {
  lend: "notes bought",
  redeem: "redemptions",
  disburse: "loan payouts",
  repay: "repaid direct",
  invoice: "invoices sent",
  client_pay: "invoices paid",
};

const IN_EDGES: ReadonlySet<FlowEdge> = new Set(["lend", "repay", "client_pay"]);

const HOT_MS = 2600;

/** The amount at the end of an activity label (`note purchase · $50.00` → `$50.00`). */
function labelAmount(label: string): string | null {
  const match = / · (\$[\d,]+\.\d{2})$/.exec(label);
  return match ? match[1]! : null;
}

function Lane({
  edge,
  latest,
  hot,
}: {
  edge: FlowEdge;
  latest: ConsoleSnapshot["flow"]["activity"][number] | undefined;
  hot: boolean;
}) {
  const amount = latest ? labelAmount(latest.label) : null;
  return (
    <span className={`lane${hot ? " hot" : ""}`} data-testid={`lane-${edge}`} data-hot={hot ? "1" : "0"}>
      {LANE_LABEL[edge]}{" "}
      {amount ? <b className={IN_EDGES.has(edge) ? "in" : undefined}>{amount}</b> : null}
    </span>
  );
}

function Connector({
  top,
  bottom,
  latest,
  hot,
}: {
  top: FlowEdge;
  bottom: FlowEdge;
  latest: Partial<Record<FlowEdge, ConsoleSnapshot["flow"]["activity"][number]>>;
  hot: Partial<Record<FlowEdge, number>>;
}) {
  return (
    <div className="cn">
      <Lane edge={top} latest={latest[top]} hot={Boolean(hot[top])} />
      <span className="cn-line" aria-hidden="true" />
      <Lane edge={bottom} latest={latest[bottom]} hot={Boolean(hot[bottom])} />
    </div>
  );
}

const shortName = (name: string) => name.split(" · ").pop() ?? name;

export function MoneyFlow({ snapshot }: { snapshot: ConsoleSnapshot }) {
  const { flow, kpis } = snapshot;
  const seen = useRef<Set<string> | null>(null);
  const [hot, setHot] = useState<Partial<Record<FlowEdge, number>>>({});

  // New activity since the last poll lights its lane. The first render only
  // primes `seen`, so a fresh page doesn't light every lane at once.
  useEffect(() => {
    const keys = flow.activity.map((a) => a.key);
    const first = seen.current === null;
    const fresh = first ? [] : flow.activity.filter((a) => !seen.current!.has(a.key));
    seen.current = new Set([...(seen.current ?? []), ...keys]);
    if (fresh.length === 0) {
      return;
    }
    const now = Date.now();
    setHot((prev) => {
      const next = { ...prev };
      for (const a of fresh) {
        next[a.edge] = now;
      }
      return next;
    });
  }, [flow.activity]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setHot((prev) => {
        const expired = Object.values(prev).some((at) => now - (at ?? 0) > HOT_MS);
        if (!expired) {
          return prev;
        }
        return Object.fromEntries(Object.entries(prev).filter(([, at]) => now - (at ?? 0) <= HOT_MS));
      });
    }, 500);
    return () => clearInterval(timer);
  }, []);

  const latest: Partial<Record<FlowEdge, ConsoleSnapshot["flow"]["activity"][number]>> = {};
  for (const a of flow.activity) {
    latest[a.edge] ??= a;
  }

  const lenderNames = flow.lenders.map((l) => shortName(l.name));
  const moreLenders = Math.max(0, flow.lenderCount - Math.min(3, lenderNames.length));
  const moreBorrowers = Math.max(0, flow.borrowerCount - Math.min(3, flow.borrowers.length));

  return (
    <section className="flow" aria-labelledby="flow-h" data-testid="money-flow">
      <h2 id="flow-h" className="sr-only">
        Money flow
      </h2>
      <p className="sr-only">
        {`Lender agents buy notes into the bank pool (${money(kpis.cashCents)} cash, ${pct(kpis.utilizationBps)} lent out); the bank pays loans out to borrower agents; borrowers invoice their clients, whose payments flow back into the pool; note holders redeem from the pool.`}
      </p>
      <div className="fn">
        <span className="lbl">Lenders · {flow.lenderCount}</span>
        <span className="v num">
          {money(kpis.notesOutstandingCents)} <small>in notes</small>
        </span>
        <span className="who">
          {lenderNames.length
            ? `${lenderNames.slice(0, 3).join(", ")}${moreLenders ? `, +${moreLenders}` : ""}`
            : "no note holders yet"}
        </span>
      </div>
      <Connector top="lend" bottom="redeem" latest={latest} hot={hot} />
      <div className="fn pool">
        <span className="lbl">Bank pool</span>
        <span className="v num" data-testid="flow-cash">
          {money(kpis.cashCents)}
        </span>
        <span className="who num">
          cash · {pct(kpis.utilizationBps)} lent out · allowance {money(kpis.allowanceCents)}
        </span>
      </div>
      <Connector top="disburse" bottom="repay" latest={latest} hot={hot} />
      <div className="fn">
        <span className="lbl">Borrowers · {flow.borrowerCount}</span>
        <span className="v num">
          {money(kpis.loansOutstandingCents)} <small>owed</small>
        </span>
        <span className="who">
          {flow.borrowers.length === 0
            ? "no open loans"
            : flow.borrowers.slice(0, 3).map((b, i) => {
                const late = b.status === "late" || b.status === "substandard";
                return (
                  <span key={`${b.name}-${i}`}>
                    {i > 0 ? ", " : ""}
                    {shortName(b.name)}
                    {late ? <span className="late"> {b.status}</span> : null}
                  </span>
                );
              })}
          {flow.borrowers.length && moreBorrowers ? `, +${moreBorrowers}` : ""}
        </span>
      </div>
      <Connector top="invoice" bottom="client_pay" latest={latest} hot={hot} />
      <div className="fn">
        <span className="lbl">Invoice payers</span>
        <span className="v">borrowers&apos; clients</span>
        <span className="who">pay invoices to the bank</span>
      </div>
    </section>
  );
}
