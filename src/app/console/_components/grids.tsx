"use client";

import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useEffect, useId, useMemo, useState } from "react";

import type { ConsoleSnapshot } from "@/server/services/console";

import { CalendarPanel } from "./calendar-panel";
import { money, pct, shortDate, statusLabel, toneFor } from "./format";

ModuleRegistry.registerModules([AllCommunityModule]);

/** AG Grid Quartz, tuned to the light tokens in globals.css (docs/design/console-v2.html). */
const gridTheme = themeQuartz.withParams({
  accentColor: "#1d4ed8",
  backgroundColor: "#ffffff",
  foregroundColor: "#15181d",
  headerBackgroundColor: "#f8f8f8",
  headerTextColor: "#181d1f",
  borderColor: "#dde2eb",
  rowHoverColor: "#eef2fd",
  oddRowBackgroundColor: "#ffffff",
  browserColorScheme: "light",
  fontFamily: "inherit",
  fontSize: 13,
  headerFontWeight: 600,
  rowHeight: 38,
  headerHeight: 40,
  wrapperBorderRadius: 8,
  spacing: 7,
});

type GridTabId = "ledger" | "loans" | "notes" | "agents";
/** P7: the Calendar tab (Bryntum Calendar) sits beside the grids. */
type TabId = GridTabId | "calendar";

function StatusPill({ value }: ICellRendererParams) {
  if (typeof value !== "string") {
    return null;
  }
  return <span className={`pill ${toneFor(value)}`}>{statusLabel(value)}</span>;
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
  { field: "day", headerName: "Day", type: "rightAligned", filter: "agNumberColumnFilter", minWidth: 80, maxWidth: 100 },
  { field: "source", headerName: "Type", minWidth: 160, cellClass: "mono" },
  { field: "account", headerName: "Account", minWidth: 170, cellClass: "mono" },
  { field: "owner", headerName: "Sub-account", minWidth: 130, valueFormatter: (p) => (p.value as string | null) ?? "" },
  moneyCol("debitCents", "Debit"),
  moneyCol("creditCents", "Credit"),
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
    valueFormatter: (p) => pct(p.value as number | null),
  },
  moneyCol("outstandingCents", "Outstanding"),
  { field: "dueSimAt", headerName: "Due", minWidth: 100, valueFormatter: (p) => shortDate(p.value as string) },
  { field: "daysLate", headerName: "Days late", type: "rightAligned", filter: "agNumberColumnFilter", minWidth: 100 },
];

const NOTE_COLS: ColDef[] = [
  { field: "holder", headerName: "Holder", minWidth: 140 },
  moneyCol("units", "Units ($)", { minWidth: 120 }),
  moneyCol("costCents", "Paid in"),
  moneyCol("earnedCents", "Earned"),
  { field: "queuedRedemptions", headerName: "Queued", type: "rightAligned", filter: "agNumberColumnFilter", minWidth: 90 },
  moneyCol("queuedCents", "Queued $"),
  { field: "pendingRedemptions", headerName: "Paying out", type: "rightAligned", minWidth: 110 },
  { field: "status", headerName: "Status", minWidth: 120, cellRenderer: StatusPill },
];

const AGENT_COLS: ColDef[] = [
  { field: "name", headerName: "Agent", minWidth: 150 },
  { field: "id", headerName: "ID", minWidth: 110, cellClass: "mono", valueFormatter: (p) => (p.value as string).slice(0, 8) },
  { field: "role", headerName: "Role", minWidth: 140 },
  { colId: "kind", headerName: "Kind", minWidth: 90, valueGetter: (p) => ((p.data as { bot?: boolean } | undefined)?.bot ? "bot" : "agent") },
  { field: "tier", headerName: "KYA tier", type: "rightAligned", filter: "agNumberColumnFilter", minWidth: 100 },
  { field: "score", headerName: "Score", type: "rightAligned", filter: "agNumberColumnFilter", minWidth: 90 },
  { field: "grade", headerName: "Grade", minWidth: 80 },
  { field: "status", headerName: "Status", minWidth: 120, cellRenderer: StatusPill },
];

const GRID_TABS: Array<{ id: GridTabId; label: string; cols: ColDef[]; foot: string }> = [
  { id: "ledger", label: "Ledger", cols: LEDGER_COLS, foot: "Double-entry: every journal entry's debits equal its credits." },
  {
    id: "loans",
    label: "Loans",
    cols: LOAN_COLS,
    foot: "APR annualises the flat fee. Late loans walk the ladder: late → penalty → substandard → charged off (+10 days).",
  },
  {
    id: "notes",
    label: "Notes",
    cols: NOTE_COLS,
    foot: "Notes are borrower-payment-dependent: not deposits, not FDIC-insured. Queued redemptions wait for the reserve floor.",
  },
  { id: "agents", label: "Agents", cols: AGENT_COLS, foot: "Agent names and ids only — no owner, email or payout details are public." },
];

const TABS: Array<{ id: TabId; label: string; foot: string }> = [
  ...GRID_TABS,
  {
    id: "calendar",
    label: "Calendar",
    foot: "Due dates, the installments agents plan for themselves, treasury memos, queued redemptions and stress events — sim dates.",
  },
];

const DEFAULT_COL: ColDef = { sortable: true, filter: true, resizable: true, flex: 1 };

export function ConsoleGrids({
  snapshot,
  worldParam,
  licenseKey,
}: {
  snapshot: ConsoleSnapshot;
  worldParam: string;
  licenseKey: string | null;
}) {
  const [tab, setTab] = useState<TabId>("ledger");
  const [filter, setFilter] = useState("");
  const [mounted, setMounted] = useState(false);
  const baseId = useId();
  // AG Grid measures the DOM: render it on the client only.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time client mount flag
  useEffect(() => setMounted(true), []);

  const rows: Record<GridTabId, Array<{ id: string }>> = useMemo(
    () => ({ ledger: snapshot.ledger, loans: snapshot.loans, notes: snapshot.notes, agents: snapshot.agents }),
    [snapshot],
  );
  const counts: Record<TabId, number | null> = {
    ledger: snapshot.ledgerEntries,
    loans: snapshot.loans.length,
    notes: snapshot.notes.length,
    agents: snapshot.agents.length,
    calendar: null,
  };
  const current = TABS.find((t) => t.id === tab)!;
  const grid = GRID_TABS.find((t) => t.id === tab);

  function onKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    const index = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
    setTab(next.id);
    document.getElementById(`${baseId}-tab-${next.id}`)?.focus();
  }

  return (
    <section className="panel gridpanel" aria-labelledby={`${baseId}-h`}>
      <h2 id={`${baseId}-h`} className="sr-only">
        Bank records
      </h2>
      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="Bank records" onKeyDown={onKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`${baseId}-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`${baseId}-panel`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              data-testid={`tab-${t.id}`}
            >
              {t.label}
              {counts[t.id] !== null ? <small className="num">{counts[t.id]!.toLocaleString("en-US")}</small> : null}
            </button>
          ))}
        </div>
        {grid ? (
        <input
          className="search"
          type="search"
          placeholder="Filter rows…"
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
        ) : (
          <CalendarPanel worldParam={worldParam} licenseKey={licenseKey} />
        )}
        <div className="q-foot">
          <span>{current.foot}</span>
          <span className="num">
            {tab === "ledger"
              ? `${snapshot.ledger.length.toLocaleString("en-US")} lines · latest ${Math.min(snapshot.ledgerEntries, 150)} of ${snapshot.ledgerEntries.toLocaleString("en-US")} entries`
              : grid
                ? `${rows[grid.id].length.toLocaleString("en-US")} rows`
                : "Bryntum Calendar · month / week / agenda"}
          </span>
        </div>
      </div>
    </section>
  );
}
