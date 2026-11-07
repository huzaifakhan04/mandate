import Link from "next/link";

import { IconArrowRight, IconCheck } from "@/components/ui/icons";
import type { AgentCardView, AgentDisplayStatus, DashboardSummary } from "@/server/services/dashboard";

import { Pill, type Tone } from "./chrome";
import { formatCents, formatShortDate, loanLabel } from "./format";

export const STATUS_PILL: Record<AgentDisplayStatus, { tone: Tone; label: string }> = {
  active: { tone: "ok", label: "Active" },
  pending: { tone: "warn", label: "Pending" },
  restricted: { tone: "warn", label: "Restricted" },
  frozen: { tone: "risk", label: "Frozen" },
  revoked: { tone: "risk", label: "Revoked" },
};

/** Loan statuses (P4 Task 4: LATE amber, SUBSTANDARD red, CHARGED_OFF red, RECOVERED green). */
export const LOAN_PILL: Record<string, { tone: Tone; label: string }> = {
  accepted: { tone: "blue", label: "Accepted" },
  disbursing: { tone: "blue", label: "Disbursing" },
  active: { tone: "ok", label: "Active" },
  repaid: { tone: "plain", label: "Repaid" },
  late: { tone: "warn", label: "Late" },
  substandard: { tone: "risk", label: "Substandard" },
  defaulted: { tone: "risk", label: "Defaulted" },
  charged_off: { tone: "dark", label: "Charged off" },
  recovered: { tone: "ok", label: "Recovered" },
  disbursement_failed: { tone: "risk", label: "Disbursement failed" },
};

export function loanPill(status: string): { tone: Tone; label: string } {
  return LOAN_PILL[status] ?? { tone: "plain", label: status };
}

/** Whether a loan is down the delinquency ladder (late, substandard or charged off). */
export function isDelinquentStatus(status: string): boolean {
  return status === "late" || status === "substandard" || status === "charged_off";
}

export function drawerHref(agentId: string, extra: Record<string, string> = {}, hash = "agent-drawer"): string {
  return `/dashboard?${new URLSearchParams({ agent: agentId, ...extra }).toString()}#${hash}`;
}

/** The summary: one inline line of figures, not tiles. */
export function SummaryStrip({ summary }: { summary: DashboardSummary }) {
  return (
    <div className="sum" role="list" aria-label="Summary">
      <div role="listitem" data-testid="stat-owed">
        Owed now<b className="num">{formatCents(summary.owedCents)}</b>
      </div>
      <div role="listitem" data-testid="stat-ceiling">
        Mandate ceiling
        <b className="num">{summary.mandateCeilingCents === null ? "—" : formatCents(summary.mandateCeilingCents)}</b>
      </div>
      <div role="listitem" data-testid="stat-active">
        Active
        <b className="num">
          {summary.activeAgents} / {summary.totalAgents}
        </b>
      </div>
    </div>
  );
}

function Step({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <li className={done ? "done" : "todo"}>
      {done ? <IconCheck size={14} /> : <span className="open" aria-hidden="true" />}
      {children}
      <span className="sr-only">{done ? " (done)" : " (to do)"}</span>
    </li>
  );
}

/** The column heads of the agent list. */
export function AgentListHead() {
  return (
    <div className="al-h" aria-hidden="true">
      <span>Agent</span>
      <span>Status</span>
      <span>KYA</span>
      <span className="n">Score</span>
      <span className="n c-cap">Per loan / total</span>
      <span className="n">Owed</span>
      <span className="n c-due">Next due</span>
    </div>
  );
}

/** One agent as a dense row; the name links to its drawer (`?agent=`), and the whole row is the hit area. */
export function AgentCard({ agent, selected }: { agent: AgentCardView; selected: boolean }) {
  const pill = STATUS_PILL[agent.display];
  const loan = agent.openLoan;
  const delinquent = loan ? isDelinquentStatus(loan.status) : false;
  const owed = loan ? (delinquent ? loan.dueNowCents : loan.outstandingCents) : 0n;
  const due = loan ? formatShortDate(loan.dueSimAt) : null;
  const total = agent.mandate ? formatCents(agent.mandate.maxTotalOwedCents) : null;
  const meta = [
    `T${agent.tier.tier}`,
    `${agent.credit.score} ${agent.credit.grade}`,
    agent.mandate ? `${formatCents(agent.perLoanCapCents)}/loan, ${total} total` : "no mandate",
    due ? `${delinquent ? "was due" : "due"} ${due}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className={`al${selected ? " sel" : ""}`} data-testid="agent-card" data-agent-id={agent.id}>
      <span className="nm">
        <span className="av" aria-hidden="true">
          {agent.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="nm-t">
          <Link className="al-link" href={drawerHref(agent.id)} aria-label={`View details for ${agent.name}`}>
            <b>{agent.name}</b>
          </Link>
          <small>
            {agent.operator} · {agent.model}
          </small>
        </span>
      </span>
      <span className="c-st">
        <Pill tone={pill.tone}>{pill.label}</Pill>
      </span>
      <span className="c-tier">
        <span data-testid="card-tier">T{agent.tier.tier}</span>
      </span>
      <span className="c-score n grade">
        <span data-testid="card-score">
          {agent.credit.score} · <span data-testid="card-grade">{agent.credit.grade}</span>
        </span>
      </span>
      <span className="c-cap n">
        <span data-testid="card-cap">{formatCents(agent.perLoanCapCents)}</span>
        <span className="faint"> / {total ?? "—"}</span>
      </span>
      <span className="c-owed n">{formatCents(owed)}</span>
      <span className={`c-due n${delinquent ? " warn" : due ? "" : " faint"}`}>{due ?? "—"}</span>
      <span className="c-meta">{meta}</span>

      {agent.display === "pending" ? (
        <div className="al-x">
          <ul className="steps">
            <Step done>Claimed via Verify with PayPal</Step>
            <Step done={agent.hasApprovedDocument}>Upload KYA documents</Step>
            <Step done={agent.tier.hasCurrentMandate}>Sign a mandate</Step>
          </ul>
          <Link className="al-act" href={drawerHref(agent.id, { edit: "mandate" }, "mandate")}>
            Finish setup <IconArrowRight size={12} />
          </Link>
        </div>
      ) : agent.display === "frozen" ? (
        <div className="al-x">
          <span className="faint">Frozen by you: its calls that move money are refused until you unfreeze it.</span>
        </div>
      ) : loan && delinquent ? (
        <div className="al-x num" data-testid="card-delinquency">
          <Pill tone={loanPill(loan.status).tone}>{loanPill(loan.status).label}</Pill>
          <span>
            Loan <span className="mono">{loanLabel(loan.id)}</span> · {formatCents(loan.dueNowCents)}{" "}
            {loan.status === "charged_off" ? "recoverable" : "due now"} ·{" "}
            <span className="late" data-testid="card-days-late">
              {loan.daysLate} {loan.daysLate === 1 ? "day" : "days"} late
            </span>
            {loan.lateFeesCents > 0n ? ` · late fee ${formatCents(loan.lateFeesCents)}` : ""}
            {loan.penaltyCents > 0n ? ` · penalty ${formatCents(loan.penaltyCents)}` : ""}
          </span>
        </div>
      ) : null}
    </article>
  );
}

/** "Paste claim link": an inline input row. */
export function PasteClaimCard({ error }: { error: boolean }) {
  return (
    <div className="claim-row">
      <form method="post" action="/dashboard/claim">
        <label htmlFor="claim-link" className="lbl">
          Paste claim link
        </label>
        <input
          className="ui-input"
          id="claim-link"
          name="claim_link"
          placeholder="https://…/claim/…"
          autoComplete="off"
          required
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? "claim-link-error" : "claim-link-hint"}
        />
        <button type="submit" className="ui-btn">
          Open
        </button>
      </form>
      {error ? (
        <p id="claim-link-error" role="alert" className="claim-err">
          That doesn&apos;t look like a Mandate claim link.
        </p>
      ) : (
        <p id="claim-link-hint" className="claim-hint">
          The link your agent printed, like <span className="mono">…/claim/…</span>
        </p>
      )}
    </div>
  );
}
