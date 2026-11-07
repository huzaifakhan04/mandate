"use client";

import { useState } from "react";

import { IconShield } from "@/components/ui/icons";
import type { ConsoleSnapshot } from "@/server/services/console";
import type { ConsoleSearchResult } from "@/server/services/consoleSearch";

import { money, shortDate, statusLabel } from "./format";

const REC_TONE: Record<string, string> = { clear: "ok", keep: "warn", escalate: "risk" };

/**
 * P7 — the console's Risk Desk: open risk flags by kind, the latest flags
 * with the investigator's advisory verdict, and the hybrid search box
 * (semantic over application purposes, keyword over events).
 */
export function RiskDesk({ snapshot, worldParam }: { snapshot: ConsoleSnapshot; worldParam: string }) {
  const { risk } = snapshot;
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConsoleSearchResult | null>(null);
  const [error, setError] = useState("");

  async function search(event: React.FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/console/search?world=${encodeURIComponent(worldParam)}&q=${encodeURIComponent(query.trim())}`,
        { cache: "no-store" },
      );
      const body = (await res.json()) as { ok: boolean; result?: ConsoleSearchResult; message?: string };
      if (!res.ok || !body.ok || !body.result) {
        setError(body.message ?? "Search failed.");
        setResult(null);
      } else {
        setResult(body.result);
        if (body.result.error) setError("Search is unavailable right now.");
      }
    } catch {
      setError("Search failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="risk-desk">
      <section aria-labelledby="risk-h" data-testid="risk-panel">
        <div className="rd-h">
          <h3 id="risk-h">Risk Desk</h3>
          <span className={`ui-st ${risk.open > 0 ? "risk" : "ok"}`} data-testid="risk-open-count">
            {risk.open} open
          </span>
          <span className="r">Elastic ES|QL detectors · advisory AI case files</span>
        </div>
        {risk.note ? (
          <p className="rd-line" data-testid="risk-note">
            {risk.note}
          </p>
        ) : null}
        <ul className="risk-kinds" aria-label="Open flags by kind">
          {risk.byKind.map((k) => (
            <li key={k.kind} data-testid={`risk-kind-${k.kind}`}>
              <span>{k.label}</span>
              <b className={`num${k.open > 0 ? " risk" : ""}`}>{k.open}</b>
            </li>
          ))}
        </ul>
        {risk.recent.length === 0 ? (
          <p className="rd-line">
            <IconShield size={14} />
            No risk flags yet.
          </p>
        ) : (
          <ul className="rd-list" aria-label="Latest risk flags">
            {risk.recent.map((f) => (
              <li key={f.id}>
                <time className="num">{shortDate(f.sinceSimAt)}</time>
                <span className="line">
                  <span className="mono">{f.flag}</span> · {f.label}
                  <span className="ref"> · {f.agent}</span>
                </span>
                <span className="meta">
                  <span className={`ui-st ${f.status === "open" ? "risk" : ""}`}>{f.status}</span>
                  {f.recommendation ? (
                    <span className={`ui-st ${REC_TONE[f.recommendation] ?? ""}`} title={`case file: ${f.source ?? "?"}`}>
                      {f.recommendation}
                    </span>
                  ) : (
                    <span className="ui-st ring">investigating</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="search-h" data-testid="risk-search">
        <div className="rd-h">
          <h3 id="search-h">Search</h3>
          <span className="r">semantic (Jina) over purposes · keyword over events</span>
        </div>
        <form className="risk-search" onSubmit={search} role="search">
          <label className="sr-only" htmlFor="risk-q">
            Search applications and events
          </label>
          <input
            id="risk-q"
            className="ui-input"
            type="search"
            maxLength={200}
            value={query}
            placeholder={risk.enabled ? "e.g. GPU compute for a client project, loan.declined" : "search disabled"}
            disabled={!risk.enabled}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" className="ui-btn" disabled={busy || !risk.enabled || query.trim().length < 2}>
            {busy ? "Searching…" : "Search"}
          </button>
        </form>
        {error ? <p className="rd-line">{error}</p> : null}
        {result && !result.error ? (
          <div className="risk-results" data-testid="risk-search-results">
            <h4>Applications</h4>
            {result.applications.length === 0 ? <p className="rd-line">No matching applications.</p> : null}
            <ul className="rd-list">
              {result.applications.map((a) => (
                <li key={a.label}>
                  <time className="num">{shortDate(a.simAt)}</time>
                  <span className="line">
                    {a.purpose}
                    <span className="ref num">
                      {" "}
                      · {a.agent} · {money(a.amountCents)} / {a.termDays}d
                    </span>
                  </span>
                  <span className="meta">
                    <span className={`ui-st ${a.decision === "declined" ? "risk" : "ok"}`}>{statusLabel(a.decision)}</span>
                  </span>
                </li>
              ))}
            </ul>
            <h4>Events</h4>
            {result.events.length === 0 ? <p className="rd-line">No matching events.</p> : null}
            <ul className="rd-list">
              {result.events.map((e, i) => (
                <li key={`${e.type}-${e.simAt}-${i}`}>
                  <time className="num">{shortDate(e.simAt)}</time>
                  <span className="line">
                    <span className="mono">{e.type}</span>
                    <span className="ref">
                      {" "}
                      · {e.agent}
                      {e.amountCents !== null ? ` · ${money(e.amountCents)}` : ""}
                      {e.reasons.length ? ` · ${e.reasons.join(", ")}` : ""}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </div>
  );
}
