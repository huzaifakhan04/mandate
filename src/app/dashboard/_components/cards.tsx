import Link from "next/link";

import type { AgentCardView, AgentDisplayStatus, DashboardSummary } from "@/server/services/dashboard";

import { Pill, type Tone } from "./chrome";
import { formatCents, loanLabel, shortId } from "./format";

export const STATUS_PILL: Record<AgentDisplayStatus, { tone: Tone; label: string }> = {
  active: { tone: "ok", label: "Active" },
  pending: { tone: "warn", label: "Pending" },
  restricted: { tone: "warn", label: "Restricted" },
  frozen: { tone: "risk", label: "Frozen" },
  revoked: { tone: "risk", label: "Revoked" },
};

export function drawerHref(agentId: string, extra: Record<string, string> = {}, hash = "agent-drawer"): string {
  return `/dashboard?${new URLSearchParams({ agent: agentId, ...extra }).toString()}#${hash}`;
}

export function SummaryStrip({ summary }: { summary: DashboardSummary }) {
  return (
    <div className="stats" role="list" aria-label="Summary">
      <div className="stat" role="listitem" data-testid="stat-owed">
        <b className="num">{formatCents(summary.owedCents)}</b>
        <span>Owed across agents</span>
      </div>
      <div className="stat" role="listitem" data-testid="stat-ceiling">
        <b className="num">{summary.mandateCeilingCents === null ? "—" : formatCents(summary.mandateCeilingCents)}</b>
        <span>Mandate ceiling</span>
      </div>
      <div className="stat" role="listitem" data-testid="stat-active">
        <b className="num">
          {summary.activeAgents} / {summary.totalAgents}
        </b>
        <span>Agents active</span>
      </div>
    </div>
  );
}

/** The score ring (P3): the Agent Credit Score out of 100, with its grade in the middle. */
function ScoreRing({ score, grade }: { score: number; grade: string }) {
  const circumference = 2 * Math.PI * 24;
  const filled = (circumference * Math.min(Math.max(score, 0), 100)) / 100;
  return (
    <svg className="tier-ring" viewBox="0 0 58 58" role="img" aria-label={`Agent Credit Score ${score} of 100, grade ${grade}`}>
      <circle cx="29" cy="29" r="24" fill="none" stroke="#EEF0F3" strokeWidth="6" />
      {score > 0 ? (
        <circle
          cx="29"
          cy="29"
          r="24"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${filled.toFixed(1)} ${circumference.toFixed(1)}`}
          transform="rotate(-90 29 29)"
        />
      ) : null}
      <text x="29" y="28" textAnchor="middle" fontSize="15" fontWeight="700" fill="var(--ink)">
        {score}
      </text>
      <text x="29" y="41" textAnchor="middle" fontSize="9" fontWeight="600" fill="var(--muted)">
        {grade}
      </text>
    </svg>
  );
}

function Step({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <li>
      <span className={`d ${done ? "done" : "todo"}`} aria-hidden="true">
        {done ? "✓" : "·"}
      </span>
      {children}
      <span className="sr-only">{done ? " (done)" : " (to do)"}</span>
    </li>
  );
}

export function AgentCard({ agent, selected }: { agent: AgentCardView; selected: boolean }) {
  const pill = STATUS_PILL[agent.display];
  const loan = agent.openLoan;
  const head = (
    <div className="card-h">
      <div className={`ag${agent.display === "active" ? "" : " muted"}`} aria-hidden="true">
        {agent.name.slice(0, 1).toUpperCase()}
      </div>
      <div>
        <h3>{agent.name}</h3>
        <p className="mono">agt_{shortId(agent.id)}</p>
      </div>
      <Pill tone={pill.tone}>{pill.label}</Pill>
    </div>
  );

  if (agent.display === "pending") {
    return (
      <article className={`card${selected ? " sel" : ""}`} data-testid="agent-card" data-agent-id={agent.id}>
        {head}
        <p className="lead">
          {agent.name} is yours and can lend now. It needs a signed mandate before it can borrow.
        </p>
        <ul className="steps">
          <Step done>Claimed via Verify with PayPal</Step>
          <Step done={agent.hasApprovedDocument}>Upload KYA documents</Step>
          <Step done={agent.tier.hasCurrentMandate}>Sign a mandate</Step>
        </ul>
        <div className="foot">
          <Link className="btn primary block" href={drawerHref(agent.id, { edit: "mandate" }, "mandate")}>
            Finish setup →
          </Link>
        </div>
      </article>
    );
  }

  return (
    <article className={`card${selected ? " sel" : ""}`} data-testid="agent-card" data-agent-id={agent.id}>
      {head}
      <div className="score">
        <ScoreRing score={agent.credit.score} grade={agent.credit.grade} />
        <div className="kv num">
          <span>Credit score</span>
          <b data-testid="card-score">
            {agent.credit.score} · <span data-testid="card-grade">{agent.credit.grade}</span>
          </b>
          <span>KYA tier</span>
          <b>
            <Pill tone={agent.tier.tier === 0 ? "warn" : agent.tier.tier === 1 ? "blue" : "ok"} label={`KYA tier T${agent.tier.tier}`}>
              <span data-testid="card-tier">T{agent.tier.tier}</span>
            </Pill>
          </b>
          <span>Per-loan cap</span>
          <b data-testid="card-cap">{formatCents(agent.perLoanCapCents)}</b>
        </div>
      </div>
      {agent.display === "frozen" ? (
        <p className="lead">Frozen by you: its calls that move money are refused until you unfreeze it.</p>
      ) : loan ? (
        <div>
          <div className="loanline num">
            <span>
              Loan {loanLabel(loan.id)} · <b>{formatCents(loan.outstandingCents)}</b>
            </span>
            <span>
              {loan.dayOfTerm !== null && loan.termDays ? `Day ${loan.dayOfTerm} of ${loan.termDays}` : loan.status}
            </span>
          </div>
          <div className="prog" aria-hidden="true">
            <i
              style={{
                width: `${loan.dayOfTerm !== null && loan.termDays ? Math.round((loan.dayOfTerm / loan.termDays) * 100) : 0}%`,
              }}
            />
          </div>
        </div>
      ) : (
        <p className="lead">
          {agent.mandate
            ? `Mandate v${agent.mandate.version} · up to ${formatCents(agent.mandate.maxTotalOwedCents)} owed. No open loan.`
            : "No open loan."}
        </p>
      )}
      <div className="foot">
        <Link className="btn block" href={drawerHref(agent.id)} aria-label={`View details for ${agent.name}`}>
          View details
        </Link>
      </div>
    </article>
  );
}

export function PasteClaimCard({ error }: { error: boolean }) {
  return (
    <article className="card add">
      <div className="plus" aria-hidden="true">
        +
      </div>
      <div>
        <h2>Paste claim link from an agent</h2>
        <p style={{ margin: "4px 0 0", fontSize: 12 }}>
          Your agent printed a link like <span className="mono">…/claim/…</span>
        </p>
      </div>
      <form method="post" action="/dashboard/claim">
        <label className="sr-only" htmlFor="claim-link">
          Claim link
        </label>
        <input
          id="claim-link"
          name="claim_link"
          placeholder="https://…/claim/…"
          autoComplete="off"
          required
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? "claim-link-error" : undefined}
        />
        <button type="submit" className="btn primary">
          Open
        </button>
      </form>
      {error ? (
        <p id="claim-link-error" role="alert" style={{ margin: 0, fontSize: 12, color: "var(--risk-ink)" }}>
          That doesn&apos;t look like a Mandate claim link.
        </p>
      ) : null}
    </article>
  );
}
