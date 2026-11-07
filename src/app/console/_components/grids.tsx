"use client";

import {
  AllCommunityModule,
  colorSchemeDark,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type ICellRendererParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useEffect, useId, useMemo, useState } from "react";

import type { ConsoleSnapshot } from "@/server/services/console";

import { CalendarPanel } from "./calendar-panel";
import { logTime, money, pct, shortDate, statusLabel, toneFor, type Tone } from "./format";
import { RiskDesk } from "./risk";

ModuleRegistry.registerModules([AllCommunityModule]);

/** AG Grid Quartz on the dark ramp in globals.css (direction A · Live ledger). */
const gridTheme = themeQuartz.withPart(colorSchemeDark).withParams({
  accentColor: "#7f86e0",
  backgroundColor: "#08090a",
  foregroundColor: "#c8c9cc",
  textColor: "#c8c9cc",
  headerBackgroundColor: "#0e0f10",
  headerTextColor: "#8b8d93",
  borderColor: "rgba(255, 255, 255, 0.065)",
  rowHoverColor: "#151617",
  oddRowBackgroundColor: "#08090a",
  selectedRowBackgroundColor: "rgba(127, 134, 224, 0.14)",
  chromeBackgroundColor: "#0e0f10",
  browserColorScheme: "dark",
  fontFamily: "inherit",
  fontSize: 13,
  headerFontSize: 12,
  headerFontWeight: 500,
  rowHeight: 34,
  headerHeight: 32,
  wrapperBorder: false,
  wrapperBorderRadius: 6,
  borderRadius: 4,
  columnBorder: false,
  headerColumnBorder: false,
  headerColumnResizeHandleColor: "rgba(255, 255, 255, 0.065)",
  spacing: 6,
});

type GridTabId = "ledger" | "paypal" | "loans" | "notes" | "agents";
/** The records tabs: the AG Grid tables, the Risk desk and the Bryntum calendar. */
export type TabId = GridTabId | "risk" | "calendar";

const ST_CLASS: Record<Tone, string> = { ok: "ok", warn: "warn", risk: "risk", blue: "accent", grey: "" };

function StatusPill({ value }: ICellRendererParams) {
  if (typeof value !== "string") {
    return null;
  }
  return <span className={`ui-st ${ST_CLASS[toneFor(value)]}`}>{statusLabel(value)}</span>;
}

const moneyCol = (field: string, headerName: string, extra: Partial<ColDef> = {}): ColDef => ({
  field,
  headerName,
  type: "rightAligned",
  filter: "agNumberColumnFilter",
  minWidth: 110,
  valueFormatter: (p) => (p.value === null || p.value === undefined ? "" : money(p.value as number)),
  cellClass: "num",
  ...extra,
});

const LEDGER_COLS: ColDef[] = [
  { field: "entry", headerName: "Entry", minWidth: 110, cellClass: "mono" },
  { field: "day", headerName: "Day", type: "rightAligned", filter: "agNumberColumnFilter", minWidth: 80, maxWidth: 100, cellClass: "num" },
  { field: "source", headerName: "Type", minWidth: 160 },
  { field: "account", headerName: "Account", minWidth: 170, cellClass: "mono" },
  { field: "owner", headerName: "Sub-account", minWidth: 130, valueFormatter: (p) => (p.value as string | null) ?? "" },
  moneyCol("debitCents", "Debit"),
  moneyCol("creditCents", "Credit"),
];

const PAYPAL_COLS: ColDef[] = [
  { field: "at", headerName: "Time", minWidth: 100, maxWidth: 120, cellClass: "mono", valueFormatter: (p) => logTime(p.value as string) },
  { field: "kind", headerName: "Operation", minWidth: 140, cellClass: "mono" },
  { field: "purpose", headerName: "Purpose", minWidth: 160, valueFormatter: (p) => (p.value ? statusLabel(p.value as string) : "") },
  { field: "httpStatus", headerName: "HTTP", type: "rightAligned", minWidth: 80, maxWidth: 100, cellClass: "num" },
  { field: "status", headerName: "Result", minWidth: 130, cellRenderer: StatusPill },
  {
    field: "latencyMs",
    headerName: "Latency",
    type: "rightAligned",
    filter: "agNumberColumnFilter",
    minWidth: 90,
    cellClass: "num",
    valueFormatter: (p) => (p.value === null || p.value === undefined ? "" : `${p.value as number} ms`),
  },
  moneyCol("amountCents", "Amount", { minWidth: 100 }),
  { field: "paypalId", headerName: "PayPal id", minWidth: 100, cellClass: "mono", valueFormatter: (p) => (p.value as string | null) ?? "" },
  {
    field: "rail",
    headerName: "Rail",
    minWidth: 100,
    valueFormatter: (p) => ((p.value as string) === "paypal" ? "sandbox" : "simulated"),
  },
];

const LOAN_COLS: ColDef[] = [
  { field: "loan", headerName: "Loan", minWidth: 110, cellClass: "mono" },
  { field: "agent", headerName: "Agent", minWidth: 130 },
  { field: "status", headerName: "Status", minWidth: 140, cellRenderer: StatusPill },
  { field: "grade", headerName: "Grade", minWidth: 80, maxWidth: 100 },
  moneyCol("principalCents", "Principal"),
  moneyCol("feeCents", "Fee", { minWidth: 90 }),
  {
    field: "aprBps",
    headerName: "APR",
    type: "rightAligned",
    filter: "agNumberColumnFilter",
    minWidth: 90,
    cellClass: "num",
    valueFormatter: (p) => pct(p.value as number | null),
  },
  moneyCol("outstandingCents", "Outstanding"),
  { field: "dueSimAt", headerName: "Due", minWidth: 100, valueFormatter: (p) => shortDate(p.value as string) },
  { field: "daysLate", headerName: "Days late", type: "rightAligned", filter: "agNumberColumnFilter", minWidth: 100, cellClass: "num" },
];

const NOTE_COLS: ColDef[] = [
  { field: "holder", headerName: "Holder", minWidth: 140 },
  moneyCol("units", "Units ($)", { minWidth: 120 }),
  moneyCol("costCents", "Paid in"),
  moneyCol("earnedCents", "Earned"),
  { field: "queuedRedemptions", headerName: "Queued", type: "rightAligned", filter: "agNumberColumnFilter", minWidth: 90, cellClass: "num" },
  moneyCol("queuedCents", "Queued $"),
  { field: "pendingRedemptions", headerName: "Paying out", type: "rightAligned", minWidth: 110, cellClass: "num" },
  { field: "status", headerName: "Status", minWidth: 120, cellRenderer: StatusPill },
];

const AGENT_COLS: ColDef[] = [
  { field: "name", headerName: "Agent", minWidth: 150 },
  { field: "id", headerName: "ID", minWidth: 110, cellClass: "mono", valueFormatter: (p) => (p.value as string).slice(0, 8) },
  { field: "role", headerName: "Role", minWidth: 140 },
  { colId: "kind", headerName: "Kind", minWidth: 90, valueGetter: (p) => ((p.data as { bot?: boolean } | undefined)?.bot ? "bot" : "agent") },
  { field: "tier", headerName: "KYA tier", type: "rightAligned", filter: "agNumberColumnFilter", minWidth: 100, cellClass: "num" },
  { field: "score", headerName: "Score", type: "rightAligned", filter: "agNumberColumnFilter", minWidth: 90, cellClass: "num" },
  { field: "grade", headerName: "Grade", minWidth: 80 },
  { field: "status", headerName: "Status", minWidth: 120, cellRenderer: StatusPill },
];

const GRID_TABS: Array<{ id: GridTabId; label: string; cols: ColDef[]; foot: string }> = [
  { id: "ledger", label: "Ledger", cols: LEDGER_COLS, foot: "Double-entry: every journal entry's debits equal its credits." },
  { id: "paypal", label: "PayPal API log", cols: PAYPAL_COLS, foot: "Every PayPal call the bank made, newest first. Request bodies are redacted." },
  {
    id: "loans",
    label: "Loans",
    cols: LOAN_COLS,
    foot: "APR annualises the flat fee. Late loans walk the ladder: late, penalty, substandard, charged off (+10 days).",
  },
  {
    id: "notes",
    label: "Notes",
    cols: NOTE_COLS,
    foot: "Notes are borrower-payment-dependent: not deposits, not FDIC-insured. Queued redemptions wait for the reserve floor.",
  },
  { id: "agents", label: "Agents", cols: AGENT_COLS, foot: "Agent names and ids only — no owner, email or payout details are public." },
];

const TAB_ORDER: TabId[] = ["ledger", "paypal", "risk", "loans", "notes", "agents", "calendar"];
const TAB_LABEL: Record<TabId, string> = {
  ledger: "Ledger",
  paypal: "PayPal API log",
  risk: "Risk desk",
  loans: "Loans",
  notes: "Notes",
  agents: "Agents",
  calendar: "Calendar",
};
const OTHER_FOOT: Record<"risk" | "calendar", string> = {
  risk: "Elastic ES|QL detectors flag patterns; AI case files are advisory.",
  calendar: "Due dates, the installments agents plan for themselves, treasury memos, queued redemptions and stress events — sim dates.",
};

const DEFAULT_COL: ColDef = { sortable: true, filter: true, resizable: true, flex: 1, suppressHeaderFilterButton: true };

export function ConsoleGrids({
  snapshot,
  worldParam,
  licenseKey,
  tab,
  onTab,
}: {
  snapshot: ConsoleSnapshot;
  worldParam: string;
  licenseKey: string | null;
  tab: TabId;
  onTab: (tab: TabId) => void;
}) {
  const [filter, setFilter] = useState("");
  const [mounted, setMounted] = useState(false);
  const baseId = useId();
  // AG Grid measures the DOM: render it on the client only.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time client mount flag
  useEffect(() => setMounted(true), []);

  const rows: Record<GridTabId, Array<{ id: string }>> = useMemo(
    () => ({
      ledger: snapshot.ledger,
      paypal: snapshot.paypalLog,
      loans: snapshot.loans,
      notes: snapshot.notes,
      agents: snapshot.agents,
    }),
    [snapshot],
  );
  const counts: Record<TabId, string | null> = {
    ledger: snapshot.ledgerEntries.toLocaleString("en-US"),
    paypal: snapshot.paypalLog.length.toLocaleString("en-US"),
    risk: `${snapshot.risk.open} open`,
    loans: snapshot.loans.length.toLocaleString("en-US"),
    notes: snapshot.notes.length.toLocaleString("en-US"),
    agents: snapshot.agents.length.toLocaleString("en-US"),
    calendar: null,
  };
  const grid = GRID_TABS.find((t) => t.id === tab);
  const foot = grid ? grid.foot : OTHER_FOOT[tab as "risk" | "calendar"];

  function onKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    const index = TAB_ORDER.indexOf(tab);
    const next = TAB_ORDER[(index + (event.key === "ArrowRight" ? 1 : TAB_ORDER.length - 1)) % TAB_ORDER.length]!;
    onTab(next);
    document.getElementById(`${baseId}-tab-${next}`)?.focus();
  }

  return (
    <section className="gridpanel" aria-labelledby={`${baseId}-h`}>
      <h2 id={`${baseId}-h`} className="sr-only">
        Bank records
      </h2>
      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="Bank records" onKeyDown={onKey}>
          {TAB_ORDER.map((id) => (
            <button
              key={id}
              id={`${baseId}-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-controls={`${baseId}-panel`}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => onTab(id)}
              data-testid={`tab-${id}`}
            >
              {TAB_LABEL[id]}
              {counts[id] !== null ? <small className={`num${id === "risk" && snapshot.risk.open > 0 ? " risk" : ""}`}>{counts[id]}</small> : null}
            </button>
          ))}
        </div>
        {grid ? (
          <input
            className="ui-input search"
            type="search"
            placeholder="Filter rows"
            aria-label="Filter rows"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-testid="grid-filter"
          />
        ) : null}
      </div>
      <div className="pb" id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${tab}`}>
        {grid ? (
          <div className="gridbox" data-testid={`grid-${tab}`}>
            {mounted ? (
              <AgGridReact
                key={tab}
                theme={gridTheme}
                rowData={rows[grid.id]}
                columnDefs={grid.cols}
                defaultColDef={DEFAULT_COL}
                getRowId={(p) => (p.data as { id: string }).id}
                quickFilterText={filter}
                animateRows={false}
                suppressDragLeaveHidesColumns
                overlayNoRowsTemplate="<span>Nothing here yet.</span>"
              />
            ) : null}
          </div>
        ) : tab === "risk" ? (
          <RiskDesk snapshot={snapshot} worldParam={worldParam} />
        ) : (
          <CalendarPanel worldParam={worldParam} licenseKey={licenseKey} />
        )}
        <div className="q-foot">
          <span>{foot}</span>
          <span className="num">
            {tab === "ledger"
              ? `${snapshot.ledger.length.toLocaleString("en-US")} lines · latest ${Math.min(snapshot.ledgerEntries, 150)} of ${snapshot.ledgerEntries.toLocaleString("en-US")} entries`
              : grid
                ? `${rows[grid.id].length.toLocaleString("en-US")} rows`
                : tab === "calendar"
                  ? "Bryntum Calendar · month / week / agenda"
                  : `${snapshot.risk.open} open`}
          </span>
        </div>
      </div>
    </section>
  );
}
