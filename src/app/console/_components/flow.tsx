"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ConsoleSnapshot, FlowEdge } from "@/server/services/console";

import { money, pct } from "./format";

/**
 * The money-flow panel: lenders → bank pool → borrowers → their clients →
 * back to the pool, as plain SVG. Lanes with any recent activity carry a
 * slow ambient token (SMIL); each NEW activity row since the last poll
 * fires a bright burst along its lane (requestAnimationFrame along the
 * path) and lights the lane for a moment. Reduced motion: no tokens, the
 * lane highlight and the text ticker still update.
 */

type Lane = { id: FlowEdge; d: string; kind: "in" | "out" | "doc"; label: string };

const LANES: Lane[] = [
  { id: "lend", d: "M190,112 C240,112 240,122 290,122", kind: "in", label: "note purchases" },
  { id: "redeem", d: "M290,196 C240,196 240,206 190,206", kind: "out", label: "redemptions" },
  { id: "disburse", d: "M470,96 C520,96 520,78 570,78", kind: "out", label: "loan payouts" },
  { id: "repay", d: "M570,118 C520,118 520,128 470,128", kind: "in", label: "direct repayments" },
  { id: "invoice", d: "M660,146 L660,196", kind: "doc", label: "invoices to clients" },
  { id: "client_pay", d: "M570,250 C520,250 520,200 470,200", kind: "in", label: "client payments" },
];

const EDGE_COLOR: Record<Lane["kind"], string> = { in: "#0f9d58", out: "#1d4ed8", doc: "#6b3fb3" };

const BURST_MS = 1300;
const HOT_MS = 2600;

interface Burst {
  key: string;
  edge: FlowEdge;
}

function BurstToken({ burst, onDone }: { burst: Burst; onDone: (key: string) => void }) {
  const ref = useRef<SVGCircleElement>(null);
  useEffect(() => {
    const path = ref.current?.ownerSVGElement?.querySelector<SVGPathElement>(`[data-lane="${burst.edge}"]`) ?? null;
    if (!path || !ref.current) {
      onDone(burst.key);
      return;
    }
    const total = path.getTotalLength();
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / BURST_MS);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const point = path.getPointAtLength(eased * total);
      ref.current?.setAttribute("cx", String(point.x));
      ref.current?.setAttribute("cy", String(point.y));
      if (t < 1) {
        frame = requestAnimationFrame(step);
      } else {
        onDone(burst.key);
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [burst.key, burst.edge, onDone]);
  const lane = LANES.find((l) => l.id === burst.edge)!;
  return <circle ref={ref} className="burst" r="6" cx="-20" cy="-20" fill={EDGE_COLOR[lane.kind]} />;
}

export function MoneyFlow({ snapshot }: { snapshot: ConsoleSnapshot }) {
  const { flow, kpis } = snapshot;
  const seen = useRef<Set<string> | null>(null);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [hot, setHot] = useState<Partial<Record<FlowEdge, number>>>({});

  // New activity since the last poll → bursts. The first render only
  // primes `seen` and lights the newest few rows, so a fresh page isn't a
  // firework of the whole history.
  useEffect(() => {
    const keys = flow.activity.map((a) => a.key);
    const fresh = seen.current === null ? flow.activity.slice(0, 3) : flow.activity.filter((a) => !seen.current!.has(a.key));
    seen.current = new Set([...(seen.current ?? []), ...keys]);
    if (fresh.length === 0) {
      return;
    }
    const now = Date.now();
    setBursts((prev) => [...prev, ...fresh.slice(0, 8).map((a) => ({ key: a.key, edge: a.edge }))]);
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
        const expired = Object.entries(prev).some(([, at]) => now - (at ?? 0) > HOT_MS);
        if (!expired) {
          return prev;
        }
        return Object.fromEntries(Object.entries(prev).filter(([, at]) => now - (at ?? 0) <= HOT_MS));
      });
    }, 500);
    return () => clearInterval(timer);
  }, []);

  const done = useCallback((key: string) => setBursts((prev) => prev.filter((b) => b.key !== key)), []);
  const activeEdges = new Set(flow.activity.map((a) => a.edge));
  const utilWidth = Math.max(0, Math.min(120, (kpis.utilizationBps / 10_000) * 120));

  const nodeRows = (rows: Array<{ title: string; sub: string; color: string }>, x: number, y: number) =>
    rows.map((row, i) => (
      <g key={i} transform={`translate(${x},${y + i * 30})`}>
        <rect width="22" height="22" rx="6" fill={row.color} />
        <text x="11" y="15" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff">
          {row.title.slice(0, 1).toUpperCase()}
        </text>
        <text x="30" y="10" fontSize="12" fontWeight="700" fill="#15181d">
          {row.title.length > 14 ? `${row.title.slice(0, 13)}…` : row.title}
        </text>
        <text x="30" y="22" fontSize="10.5" fill="#5b6472">
          {row.sub}
        </text>
      </g>
    ));

  const shortName = (name: string) => name.split(" · ").pop() ?? name;
  const lenders = flow.lenders.map((l) => ({ title: shortName(l.name), sub: `${money(l.notesCents)} in notes`, color: "#0f9d58" }));
  const borrowers = flow.borrowers.map((b) => ({
    title: shortName(b.name),
    sub: `${b.grade ? `${b.grade} · ` : ""}${money(b.principalCents)} ${b.status}`,
    color: b.status === "late" || b.status === "substandard" ? "#d93025" : "#1d4ed8",
  }));

  return (
    <>
      <svg
        className="flow"
        viewBox="0 0 760 300"
        role="img"
        aria-labelledby="flow-title flow-desc"
        data-testid="money-flow"
      >
        <title id="flow-title">Money flow</title>
        <desc id="flow-desc">
          {`Lender agents buy notes into the bank pool (${money(kpis.cashCents)} cash, ${pct(kpis.utilizationBps)} lent out); the bank pays loans out to borrower agents; borrowers invoice their clients, whose payments flow back into the pool; note holders redeem from the pool.`}
        </desc>
        <text x="100" y="22" textAnchor="middle" fontSize="11" fontWeight="700" fill="#6b7380" letterSpacing="1">
          LENDERS · {flow.lenderCount}
        </text>
        <text x="380" y="22" textAnchor="middle" fontSize="11" fontWeight="700" fill="#6b7380" letterSpacing="1">
          BANK POOL
        </text>
        <text x="660" y="14" textAnchor="middle" fontSize="11" fontWeight="700" fill="#6b7380" letterSpacing="1">
          BORROWERS · {flow.borrowerCount}
        </text>
        <text x="660" y="292" textAnchor="middle" fontSize="11" fontWeight="700" fill="#6b7380" letterSpacing="1">
          THEIR CLIENTS
        </text>

        {LANES.map((lane) => (
          <path
            key={lane.id}
            data-lane={lane.id}
            className={`lane ${lane.kind}${hot[lane.id] ? " hot" : ""}`}
            d={lane.d}
            data-testid={`lane-${lane.id}`}
            data-hot={hot[lane.id] ? "1" : "0"}
          />
        ))}

        {/* lenders */}
        <rect x="10" y="40" width="180" height="230" rx="12" fill="#fff" stroke="#e3e6eb" />
        {lenders.length ? (
          nodeRows(lenders, 22, 54)
        ) : (
          <text x="100" y="150" textAnchor="middle" fontSize="12" fill="#6b7380">
            no note holders yet
          </text>
        )}
        {flow.lenderCount > lenders.length ? (
          <text x="22" y="252" fontSize="11" fill="#6b7380">
            + {flow.lenderCount - lenders.length} more
          </text>
        ) : null}

        {/* bank */}
        <rect x="290" y="60" width="180" height="180" rx="18" fill="#fff" stroke="#1d4ed8" strokeWidth="1.5" />
        <rect x="360" y="74" width="40" height="40" rx="11" fill="#1d4ed8" />
        <text x="380" y="101" textAnchor="middle" fontSize="18" fontWeight="700" fill="#fff">
          M
        </text>
        <text x="380" y="134" textAnchor="middle" fontSize="13" fontWeight="700" fill="#15181d">
          Mandate bank
        </text>
        <text x="380" y="160" textAnchor="middle" fontSize="19" fontWeight="700" fill="#15181d" className="num" data-testid="flow-cash">
          {money(kpis.cashCents)}
        </text>
        <text x="380" y="177" textAnchor="middle" fontSize="11" fill="#5b6472">
          cash · {pct(kpis.utilizationBps)} lent out
        </text>
        <rect x="320" y="188" width="120" height="7" rx="3.5" fill="#eef0f3" />
        <rect x="320" y="188" width={utilWidth} height="7" rx="3.5" fill="#1d4ed8" />
        <text x="380" y="220" textAnchor="middle" fontSize="10.5" fill="#6b7380">
          allowance (CECL) {money(kpis.allowanceCents)}
        </text>

        {/* borrowers */}
        <rect x="570" y="24" width="180" height="122" rx="12" fill="#fff" stroke="#e3e6eb" />
        {borrowers.length ? (
          nodeRows(borrowers, 582, 36)
        ) : (
          <text x="660" y="90" textAnchor="middle" fontSize="12" fill="#6b7380">
            no open loans
          </text>
        )}

        {/* clients */}
        <rect x="570" y="196" width="180" height="80" rx="12" fill="#fff" stroke="#e3e6eb" />
        <text x="660" y="230" textAnchor="middle" fontSize="12" fontWeight="700" fill="#15181d">
          Invoice payers
        </text>
        <text x="660" y="248" textAnchor="middle" fontSize="10.5" fill="#5b6472">
          pay borrowers&apos; invoices to the bank
        </text>

        {LANES.filter((lane) => activeEdges.has(lane.id)).map((lane) => (
          <circle key={`amb-${lane.id}`} className={`tok tok-${lane.kind}`} r="3.5">
            <animateMotion dur="3.6s" repeatCount="indefinite" path={lane.d} />
          </circle>
        ))}
        {bursts.map((burst) => (
          <BurstToken key={burst.key} burst={burst} onDone={done} />
        ))}
      </svg>
      <ul className="ticker" aria-label="Latest money movements" data-testid="flow-ticker">
        {flow.activity.slice(0, 4).map((a) => {
          const lane = LANES.find((l) => l.id === a.edge)!;
          return (
            <li key={a.key}>
              <span className="dot" style={{ background: EDGE_COLOR[lane.kind] }} aria-hidden="true" />
              <span>{a.label}</span>
            </li>
          );
        })}
        {flow.activity.length === 0 ? <li>No money has moved yet.</li> : null}
      </ul>
    </>
  );
}
