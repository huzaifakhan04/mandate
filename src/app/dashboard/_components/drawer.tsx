import Link from "next/link";

import { IconCheck, IconX } from "@/components/ui/icons";
import { LEGAL } from "@/components/ui/legal";

import { MANDATE_AGREEMENT_TEXT, MANDATE_BOUNDS } from "@/server/domain/mandate";
import type { AgentDetailView, AgentEventView, LoanSummary } from "@/server/services/dashboard";
import { KYA_DOCUMENT_KINDS } from "@/server/services/kyaDocs";

import { STATUS_PILL, drawerHref, isDelinquentStatus, loanPill } from "./cards";
import { Pill } from "./chrome";
import { DrawerKeys } from "./drawer-keys";
import { approveHref, centsInputValue, formatBps, formatCents, formatDate, formatDateTime, loanLabel, shortId } from "./format";

export type DrawerTab = "loans" | "notes" | "events";

export type DrawerParams = Record<string, string | undefined>;

const COLLATERAL_LABEL: Record<string, string> = {
  invoice_link: "Invoice payment link",
  none: "None (unsecured)",
};

const DOC_KIND_LABEL: Record<string, string> = {
  operator_registration: "Operator registration",
  code_manifest: "Code manifest",
  other: "Other",
};

/** Field-level messages for a rejected mandate form (codes from `parseMandateSignInput`). */
const MANDATE_FIELD_ERRORS: Record<string, string> = {
  max_per_loan_cents: `Max per loan must be between ${formatCents(MANDATE_BOUNDS.maxPerLoanCents.min)} and ${formatCents(MANDATE_BOUNDS.maxPerLoanCents.max)}.`,
  max_total_owed_cents: `Max total owed must be between ${formatCents(MANDATE_BOUNDS.maxTotalOwedCents.min)} and ${formatCents(MANDATE_BOUNDS.maxTotalOwedCents.max)}.`,
  max_fee_bps: "Max fee must be between 0% and 100% of the loan.",
  max_term_days: `Max term must be ${MANDATE_BOUNDS.maxTermDays.min}–${MANDATE_BOUNDS.maxTermDays.max} days.`,
  eligible_collateral: "Pick at least one kind of collateral.",
  expires_at: "The expiry date must be in the future.",
  typed_name: "Type your full name (2–100 characters) to sign.",
  agree: "Tick the box to agree to the mandate.",
};

const NOTICES: Record<string, Record<string, { tone: "ok" | "err"; text: string }>> = {
  mandate: {
    signed: { tone: "ok", text: "Mandate signed. The new version is in force now." },
    revoked: { tone: "ok", text: "Mandate revoked. The agent can't borrow; its existing loans are unaffected." },
  },
  mandate_error: {
    invalid_mandate: { tone: "err", text: "The mandate wasn't signed — check the highlighted fields." },
    no_mandate: { tone: "err", text: "There is no mandate in force to revoke." },
    invalid_body: { tone: "err", text: "The mandate form couldn't be read. Please try again." },
    too_large: { tone: "err", text: "The mandate form was too large." },
    error: { tone: "err", text: "Something went wrong. Please try again." },
  },
  document: {
    uploaded: { tone: "ok", text: "Document uploaded and approved." },
    deleted: { tone: "ok", text: "Document deleted." },
  },
  document_error: {
    too_large: { tone: "err", text: "That file is larger than 2 MB." },
    unsupported_type: { tone: "err", text: "Only PDF, PNG and JPEG files are accepted." },
    empty: { tone: "err", text: "That file is empty." },
    invalid_kind: { tone: "err", text: "Pick a document type." },
    invalid_form: { tone: "err", text: "Choose a file to upload." },
    error: { tone: "err", text: "Something went wrong saving the document." },
  },
  agent_status: {
    frozen: { tone: "ok", text: "Agent frozen. Its calls that move money are refused until you unfreeze it." },
    unfrozen: { tone: "ok", text: "Agent unfrozen. It can act again." },
  },
  risk: {
    review_requested: { tone: "ok", text: "Review requested. Your note is on the flag for the bank's risk team." },
    cleared: { tone: "ok", text: "Risk flag cleared. The agent can borrow again (subject to the usual checks)." },
  },
  risk_error: {
    forbidden: { tone: "err", text: "In the main world only the bank can clear a risk flag — request a review instead." },
    flag_not_open: { tone: "err", text: "That risk flag is no longer open." },
  },
  key: {
    revoked: { tone: "ok", text: "Signing key revoked. The agent is back to tier T1 until it registers a new key." },
  },
  error: {
    not_freezable: { tone: "err", text: "Only an active agent can be frozen." },
    not_frozen: { tone: "err", text: "This agent isn't frozen." },
    no_key: { tone: "err", text: "This agent has no active signing key." },
    agent_revoked: { tone: "err", text: "A revoked agent can't be given a new API key." },
    error: { tone: "err", text: "Something went wrong. Please try again." },
  },
};

function Notices({ params }: { params: DrawerParams }) {
  const shown = Object.entries(NOTICES).flatMap(([param, messages]) => {
    const value = params[param];
    const message = value ? messages[value] : undefined;
    return message ? [{ key: param, ...message }] : [];
  });
  if (shown.length === 0) {
    return null;
  }
  return (
    <div className="dnotices">
      {shown.map((notice) => (
        <div
          key={notice.key}
          className={`notice ${notice.tone}`}
          role={notice.tone === "err" ? "alert" : "status"}
          data-testid="drawer-notice"
        >
          {notice.text}
        </div>
      ))}
    </div>
  );
}

function Check({ done, label, detail }: { done: boolean; label: string; detail?: string }) {
  return (
    <li className={done ? "done" : "todo"}>
      {done ? <IconCheck size={16} /> : <span className="open" aria-hidden="true" />}
      <span>
        {label}
        <span className="sr-only">{done ? " (done)" : " (not yet)"}</span>
      </span>
      {detail ? <small>{detail}</small> : null}
    </li>
  );
}

function KyaSection({ agent }: { agent: AgentDetailView }) {
  const tier = agent.tier.tier;
  const approved = agent.documents.filter((doc) => doc.reviewStatus === "approved").length;
  return (
    <section className="ds" aria-labelledby="kya-h">
      <h3 id="kya-h">
        Know your agent{" "}
        <Pill tone={tier === 0 ? "warn" : tier === 1 ? "blue" : "ok"} label={`KYA tier T${tier}`}>
          <span data-testid="drawer-tier">T{tier}</span>
          {tier === 2 ? " · verified" : ""}
        </Pill>
      </h3>
      <ul className="checks">
        <Check done={agent.tier.claimed} label="Claimed by you via PayPal" detail={agent.claimedAt ? formatDate(agent.claimedAt) : undefined} />
        <Check
          done={agent.tier.hasCurrentMandate}
          label="Standing mandate signed"
          detail={agent.currentMandate ? `v${agent.currentMandate.version}` : "needed for T1"}
        />
        <Check done={approved > 0} label="KYA document approved" detail={approved > 0 ? `${approved} on file` : "needed for T2"} />
        <Check done={Boolean(agent.signingKey)} label="Ed25519 signing key" detail={agent.signingKey ? "signed requests" : "needed for T2"} />
      </ul>
      <dl className="rows">
        <dt>Agent ID</dt>
        <dd className="mono">{agent.id}</dd>
        <dt>Operator</dt>
        <dd>{agent.operator}</dd>
        <dt>Model</dt>
        <dd>{agent.model}</dd>
        <dt>Payout to</dt>
        <dd className="mono">{agent.payoutMasked ?? "—"}</dd>
        <dt>Per-loan cap</dt>
        <dd className="num">{formatCents(agent.perLoanCapCents)}</dd>
        <dt>Credit score</dt>
        <dd className="num" data-testid="drawer-score">
          {agent.credit.score} / 100 · grade {agent.credit.grade} · limit {formatCents(agent.credit.limitCents)}
        </dd>
      </dl>
      <ul className="factors" aria-label="Top score factors" data-testid="drawer-score-factors">
        {agent.credit.factors.map((factor) => (
          <li key={factor}>{factor}</li>
        ))}
      </ul>
    </section>
  );
}

function MandateForm({ agent, params }: { agent: AgentDetailView; params: DrawerParams }) {
  const current = agent.currentMandate;
  const errorFields = new Set((params.fields ?? "").split(",").filter(Boolean));
  const invalid = (field: string) => (errorFields.has(field) ? "true" : undefined);
  const open = params.edit === "mandate" || params.mandate_error === "invalid_mandate" || !current;
  const collateral = new Set(current ? current.eligibleCollateral : ["invoice_link"]);
  const err = (field: string) =>
    errorFields.has(field) ? (
      <span className="err" id={`err-${field}`}>
        {MANDATE_FIELD_ERRORS[field]}
      </span>
    ) : null;
  const describedBy = (field: string) => (errorFields.has(field) ? `err-${field}` : undefined);

  return (
    <details className="editor" open={open}>
      <summary data-testid="edit-mandate">{current ? "Edit mandate" : "Sign a mandate"}</summary>
      <form method="post" action={`/dashboard/agents/${agent.id}/mandate`} aria-label="Mandate limits">
        <div className="fields">
          <div className="field">
            <label htmlFor="m-per-loan">Max per loan</label>
            <div className="affix" aria-invalid={invalid("max_per_loan_cents")}>
              <span aria-hidden="true">$</span>
              <input
                id="m-per-loan"
                name="max_per_loan_usd"
                inputMode="decimal"
                required
                defaultValue={current ? centsInputValue(current.maxPerLoanCents) : "250"}
                aria-describedby={describedBy("max_per_loan_cents")}
              />
            </div>
            {err("max_per_loan_cents")}
          </div>
          <div className="field">
            <label htmlFor="m-total">Max total owed</label>
            <div className="affix" aria-invalid={invalid("max_total_owed_cents")}>
              <span aria-hidden="true">$</span>
              <input
                id="m-total"
                name="max_total_owed_usd"
                inputMode="decimal"
                required
                defaultValue={current ? centsInputValue(current.maxTotalOwedCents) : "500"}
                aria-describedby={describedBy("max_total_owed_cents")}
              />
            </div>
            {err("max_total_owed_cents")}
          </div>
          <div className="field">
            <label htmlFor="m-fee">Max fee</label>
            <div className="affix" aria-invalid={invalid("max_fee_bps")}>
              <input
                id="m-fee"
                name="max_fee_pct"
                inputMode="decimal"
                required
                defaultValue={current ? String(current.maxFeeBps / 100) : "10"}
                aria-describedby={describedBy("max_fee_bps") ?? "hint-fee"}
              />
              <span className="after" aria-hidden="true">
                %
              </span>
            </div>
            <span className="hint" id="hint-fee">
              Of the amount borrowed. New agents start at grade D: invoice-backed loans cost ~5.8% for 7 days; set ≥ 6% or
              the bank will decline with mandate_fee
            </span>
            {err("max_fee_bps")}
          </div>
          <div className="field">
            <label htmlFor="m-term">Max term</label>
            <div className="affix" aria-invalid={invalid("max_term_days")}>
              <input
                id="m-term"
                name="max_term_days"
                inputMode="numeric"
                required
                defaultValue={current ? String(current.maxTermDays) : "30"}
                aria-describedby={describedBy("max_term_days")}
              />
              <span className="after" aria-hidden="true">
                days
              </span>
            </div>
            {err("max_term_days")}
          </div>
        </div>
        <fieldset aria-describedby={describedBy("eligible_collateral")}>
          <legend className="lbl">Eligible collateral</legend>
          <label className="check">
            <input type="checkbox" name="eligible_collateral" value="invoice_link" defaultChecked={collateral.has("invoice_link")} />
            Invoice payment link (the bank collects the invoice)
          </label>
          <label className="check">
            <input type="checkbox" name="eligible_collateral" value="none" defaultChecked={collateral.has("none")} />
            None — unsecured loans
          </label>
          {err("eligible_collateral")}
        </fieldset>
        <div className="field">
          <label htmlFor="m-expires">Expires (optional)</label>
          <input
            className="ui-input"
            id="m-expires"
            name="expires_at"
            type="date"
            aria-invalid={invalid("expires_at")}
            aria-describedby={describedBy("expires_at")}
          />
          {err("expires_at")}
        </div>
        <p className="agreement" id="m-agreement">
          {MANDATE_AGREEMENT_TEXT}
        </p>
        <div className="field">
          <label htmlFor="m-name">Type your full name to sign</label>
          <input
            className="ui-input"
            id="m-name"
            name="typed_name"
            autoComplete="name"
            required
            minLength={2}
            maxLength={100}
            aria-invalid={invalid("typed_name")}
            aria-describedby={describedBy("typed_name")}
          />
          {err("typed_name")}
        </div>
        <label className="check">
          <input type="checkbox" name="agree" value="on" required aria-describedby="m-agreement" />
          I agree to the mandate above.
        </label>
        {err("agree")}
        <button type="submit" className="ui-btn primary sign">
          {current ? `Sign version ${current.version + 1}` : "Sign mandate"}
        </button>
      </form>
    </details>
  );
}

function MandateSection({ agent, params }: { agent: AgentDetailView; params: DrawerParams }) {
  const current = agent.currentMandate;
  const older = agent.mandateHistory.filter((m) => m.id !== current?.id);
  return (
    <section className="ds" id="mandate" aria-labelledby="mandate-h">
      <h3 id="mandate-h">Standing mandate</h3>
      {current ? (
        <div className="mandate" data-testid="mandate-card">
          <div className="mh">
            <b>Mandate v{current.version}</b>
            <Pill tone="blue">Signed</Pill>
          </div>
          <dl className="rows num">
            <dt>Max per loan</dt>
            <dd data-testid="mandate-per-loan">{formatCents(current.maxPerLoanCents)}</dd>
            <dt>Max total owed</dt>
            <dd data-testid="mandate-total">{formatCents(current.maxTotalOwedCents)}</dd>
            <dt>Eligible collateral</dt>
            <dd>{current.eligibleCollateral.map((c) => COLLATERAL_LABEL[c] ?? c).join(", ")}</dd>
            <dt>Max fee</dt>
            <dd>{formatBps(current.maxFeeBps)}</dd>
            <dt>Max term</dt>
            <dd>{current.maxTermDays} days</dd>
            {current.expiresAt ? (
              <>
                <dt>Expires</dt>
                <dd>{formatDate(current.expiresAt)}</dd>
              </>
            ) : null}
            <dt>Signed</dt>
            <dd>
              {current.signedAt ? formatDate(current.signedAt) : "—"}
              {current.signerName ? ` · ${current.signerName}` : ""}
            </dd>
          </dl>
        </div>
      ) : (
        <p className="note" data-testid="no-mandate">
          No mandate in force. {agent.name} can lend but not borrow until you sign one.
        </p>
      )}
      <MandateForm agent={agent} params={params} />
      {current ? (
        <div className="actions">
          <form method="post" action={`/dashboard/agents/${agent.id}/mandate/revoke`}>
            <button type="submit" className="ui-btn ghost">
              Revoke mandate
            </button>
          </form>
        </div>
      ) : null}
      {older.length > 0 ? (
        <p className="older">
          Earlier versions:{" "}
          {older
            .map((m) => `v${m.version} ${m.status}${m.signedAt ? ` (${formatDate(m.signedAt)})` : ""}`)
            .join(" · ")}
        </p>
      ) : null}
    </section>
  );
}

function LoanCard({ loan }: { loan: LoanSummary }) {
  const pill = loanPill(loan.status);
  const delinquent = isDelinquentStatus(loan.status);
  const progress = loan.dayOfTerm !== null && loan.termDays ? Math.round((loan.dayOfTerm / loan.termDays) * 100) : 0;
  return (
    <div className="loan" data-testid="loan-card">
      <div className="lh">
        <b className="mono">{loanLabel(loan.id)}</b>
        <span data-testid="loan-status">
          <Pill tone={pill.tone}>{pill.label}</Pill>
        </span>
      </div>
      <div className="big num">{formatCents(loan.principalCents)}</div>
      <div className="loan-sub">
        {loan.termDays ? `${loan.termDays}-day term` : "Term —"}
        {loan.dayOfTerm !== null && loan.termDays ? ` · day ${loan.dayOfTerm} of ${loan.termDays}` : ""} · due{" "}
        {formatDate(loan.dueSimAt)} (bank time)
      </div>
      <div className="prog" aria-hidden="true">
        <i style={{ width: `${progress}%` }} />
      </div>
      <dl className="rows num">
        <dt>Fee</dt>
        <dd>{formatCents(loan.feeCents)}</dd>
        {loan.lateFeesCents > 0n ? (
          <>
            <dt>Late fees</dt>
            <dd>{formatCents(loan.lateFeesCents)}</dd>
          </>
        ) : null}
        <dt>Total due</dt>
        <dd>{formatCents(loan.totalDueCents)}</dd>
        <dt>Outstanding</dt>
        <dd>{formatCents(loan.outstandingCents)}</dd>
        {loan.aprBps !== null ? (
          <>
            <dt>Est. APR</dt>
            <dd>~{formatBps(loan.aprBps)}</dd>
          </>
        ) : null}
        <dt>Collateral</dt>
        <dd>{COLLATERAL_LABEL[loan.collateral]}</dd>
      </dl>
      {delinquent || loan.lateFeesCents > 0n || loan.penaltyCents > 0n || loan.waivedCents > 0n ? (
        <dl className="rows num sub-rows" data-testid="loan-delinquency">
          {delinquent ? (
            <>
              <dt>Days late</dt>
              <dd data-testid="loan-days-late">{loan.daysLate}</dd>
            </>
          ) : null}
          <dt>Late fee</dt>
          <dd>
            {formatCents(loan.lateFeesCents)}
            {loan.lateFeeOutstandingCents > 0n && loan.lateFeeOutstandingCents !== loan.lateFeesCents
              ? ` (${formatCents(loan.lateFeeOutstandingCents)} owed)`
              : ""}
          </dd>
          <dt>Rate penalty</dt>
          <dd>
            {formatCents(loan.penaltyCents)}
            {loan.penaltyOutstandingCents > 0n && loan.penaltyOutstandingCents !== loan.penaltyCents
              ? ` (${formatCents(loan.penaltyOutstandingCents)} owed)`
              : ""}
          </dd>
          {loan.waivedCents > 0n ? (
            <>
              <dt>Waived</dt>
              <dd>{formatCents(loan.waivedCents)}</dd>
            </>
          ) : null}
          {loan.status !== "charged_off" && delinquent ? (
            <>
              <dt>Due now</dt>
              <dd data-testid="loan-due-now">{formatCents(loan.dueNowCents)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {loan.chargeOff ? (
        <dl className="rows num sub-rows" data-testid="loan-charge-off">
          <dt>Written off</dt>
          <dd>{formatCents(loan.chargeOff.writtenOffCents)}</dd>
          <dt>Recovered</dt>
          <dd>{formatCents(loan.chargeOff.recoveredCents)}</dd>
          <dt>Recoverable</dt>
          <dd data-testid="loan-recoverable">{formatCents(loan.chargeOff.recoverableCents)}</dd>
        </dl>
      ) : null}
      {loan.status === "charged_off" && loan.chargeOff?.guaranteeLink?.approveUrl && loan.chargeOff.guaranteeLink.status === "open" ? (
        <div className="link" data-testid="guarantee-link">
          <Pill tone="dark">Your guarantee · {formatCents(loan.chargeOff.guaranteeLink.amountCents)}</Pill>
          <a className="mono" href={approveHref(loan.chargeOff.guaranteeLink.approveUrl)} rel="noreferrer noopener" target="_blank">
            Pay the guarantee
          </a>
        </div>
      ) : null}
      {loan.repaymentLink?.approveUrl ? (
        <div className="link">
          <Pill tone="warn">Awaiting payer</Pill>
          <a className="mono" href={loan.repaymentLink.approveUrl} rel="noreferrer noopener" target="_blank">
            {loan.repaymentLink.approveUrl.replace(/^https?:\/\//, "")}
          </a>
        </div>
      ) : null}
    </div>
  );
}

const EVENT_LABEL: Record<string, { text: string; tone?: "g" | "r" }> = {
  "agent.registered_by_owner": { text: "Registered by you in the dashboard" },
  "agent.frozen": { text: "Frozen by you", tone: "r" },
  "agent.unfrozen": { text: "Unfrozen by you", tone: "g" },
  "agent.signing_key_revoked": { text: "Signing key revoked by you", tone: "r" },
  "agent.api_key_rotated": { text: "API key rotated by you" },
  "mandate.signed": { text: "Mandate signed", tone: "g" },
  "mandate.revoked": { text: "Mandate revoked", tone: "r" },
  "loan.declined": { text: "Loan application declined", tone: "r" },
  "loan.offered": { text: "Loan offer made" },
  "loan.accepted": { text: "Offer accepted" },
  "loan.offer_declined": { text: "Offer declined by the agent" },
  "loan.offer_expired": { text: "Offer expired" },
  "loan.disbursed": { text: "Loan disbursed", tone: "g" },
  "loan.disbursement_failed": { text: "Disbursement failed", tone: "r" },
  "loan.repayment_link_reissued": { text: "Repayment link reissued" },
  "loan.repayment_received": { text: "Repayment received", tone: "g" },
  "loan.repaid": { text: "Loan repaid in full", tone: "g" },
  "loan.remainder_held": { text: "Overpayment held (no payout receiver)" },
  "loan.remainder_paid": { text: "Overpayment returned", tone: "g" },
  "loan.remainder_payout_failed": { text: "Overpayment return failed", tone: "r" },
  // P4: the delinquency ladder, charge-off, guarantee and recovery.
  "loan.late": { text: "Loan is late: late fee added", tone: "r" },
  "loan.penalty_started": { text: "Rate penalty started (2% a year)", tone: "r" },
  "loan.substandard": { text: "Loan substandard: agent restricted, mandate frozen", tone: "r" },
  "agent.restricted": { text: "Agent restricted (can repay, can't borrow)", tone: "r" },
  "loan.charged_off": { text: "Loan charged off: your guarantee is invoked", tone: "r" },
  "loan.guarantee_reissued": { text: "Guarantee link reissued" },
  "loan.recovery_received": { text: "Recovery received", tone: "g" },
  "loan.recovered": { text: "Loan fully recovered", tone: "g" },
  "loan.cured": { text: "Late loan cured: repaid in full", tone: "g" },
  "loan.charges_waived": { text: "Post-quote charges waived (paid as quoted)" },
  "loan.holder_loss_settled": { text: "Note holders' deferred loss settled" },
  "agent.restored": { text: "Agent restored to active", tone: "g" },
  "credit.limit_increased": { text: "Limit increased", tone: "g" },
};

function eventText(event: AgentEventView): string {
  const label = EVENT_LABEL[event.type]?.text ?? event.type;
  const p = event.payload ?? {};
  if (event.type === "credit.limit_increased" && typeof p.to_grade === "string" && typeof p.limit_cents === "number") {
    return `${label}: grade ${String(p.from_grade)} to ${p.to_grade}, per-loan limit ${formatCents(p.limit_cents)}`;
  }
  if (event.type === "loan.late" && typeof p.late_fee_cents === "number") {
    return `${label} (${formatCents(p.late_fee_cents)})`;
  }
  if (event.type === "loan.charged_off" && typeof p.written_off_cents === "number") {
    return `${label} · ${formatCents(p.written_off_cents)} written off`;
  }
  const version = event.payload?.version;
  return event.type.startsWith("mandate.") && typeof version === "number" ? `${label} · v${version}` : label;
}

function Tabs({ agent, tab }: { agent: AgentDetailView; tab: DrawerTab }) {
  const tabs: Array<{ id: DrawerTab; label: string; count: number }> = [
    { id: "loans", label: "Loans", count: agent.loans.length },
    { id: "notes", label: "Notes", count: agent.notes.length },
    { id: "events", label: "Events", count: agent.events.length },
  ];
  return (
    <section className="ds" id="agent-tabs" aria-label="Activity">
      <div className="tabs" role="tablist" aria-label="Activity">
        {tabs.map((t) => (
          <Link
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={t.id === tab}
            aria-controls={`pane-${t.id}`}
            href={drawerHref(agent.id, t.id === "loans" ? {} : { tab: t.id }, "agent-tabs")}
            scroll={false}
            replace
          >
            {t.label} <span className="c">{t.count}</span>
          </Link>
        ))}
      </div>
      <div role="tabpanel" id={`pane-${tab}`} aria-labelledby={`tab-${tab}`} data-testid={`pane-${tab}`}>
        {tab === "loans" ? (
          agent.loans.length ? (
            agent.loans.map((loan) => <LoanCard key={loan.id} loan={loan} />)
          ) : (
            <p className="empty">No loans yet. Once {agent.name} borrows under its mandate, loans show here.</p>
          )
        ) : null}
        {tab === "notes" ? (
          agent.notes.length ? (
            <dl className="rows num">
              {agent.notes.map((note) => (
                <div key={note.id} style={{ display: "contents" }}>
                  <dt>
                    {note.seriesName} · {note.status}
                  </dt>
                  <dd>
                    {formatCents(note.costCents)} cost{note.accruedCents > 0n ? ` · +${formatCents(note.accruedCents)} accrued` : ""}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="empty">{agent.name} holds no notes. Agents lend by buying notes with buy_notes.</p>
          )
        ) : null}
        {tab === "events" ? (
          agent.events.length ? (
            <ul className="tl">
              {agent.events.map((event) => (
                <li key={event.id} className={EVENT_LABEL[event.type]?.tone ?? ""}>
                  {eventText(event)}
                  <small>{formatDateTime(event.occurredSimAt)} · bank time</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No events yet.</p>
          )
        ) : null}
      </div>
    </section>
  );
}

const RECOMMENDATION_TEXT: Record<string, string> = {
  clear: "looks benign — recommends clearing",
  keep: "pattern looks real — recommends keeping the flag",
  escalate: "looks deliberate — recommends escalation",
};

/** P7: the Risk Desk's flags on this agent: why, the effect, the advisory case file, and the owner's actions. */
function RiskSection({ agent }: { agent: AgentDetailView }) {
  if (agent.riskFlags.length === 0) {
    return null;
  }
  const open = agent.riskFlags.filter((f) => f.status === "open");
  return (
    <section className="ds" id="risk" aria-labelledby="risk-h" data-testid="risk-flags">
      <h3 id="risk-h">Risk review</h3>
      {open.length > 0 ? (
        <p className="notice err" role="status">
          Borrowing is limited to tier T0 while a risk flag is open (lending is unaffected). A flag clears itself 7 simulated
          days after its latest evidence.
        </p>
      ) : null}
      <ul className="tl">
        {agent.riskFlags.map((flag) => (
          <li key={flag.id} className={flag.status === "open" ? "risk" : undefined} data-testid="risk-flag">
            <b>{flag.label}</b> · {flag.status === "open" ? `open until ${formatDateTime(flag.expiresSimAt)} (bank time) unless new evidence` : `cleared${flag.clearedBy ? ` (${flag.clearedBy})` : ""}`}
            <small>{flag.reason}</small>
            {flag.caseFile ? (
              <div data-testid="risk-case-file">
                <small>
                  Case file ({flag.caseFile.source === "ai" ? "AI investigator" : "automated template"}, advisory):{" "}
                  {RECOMMENDATION_TEXT[flag.caseFile.recommendation] ?? flag.caseFile.recommendation}
                </small>
                <p>{flag.caseFile.summary}</p>
                {flag.caseFile.evidence.length ? (
                  <ul>
                    {flag.caseFile.evidence.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <small>Investigation pending.</small>
            )}
            {flag.ownerNote ? <small>Your review note: {flag.ownerNote}</small> : null}
            {flag.status === "open" ? (
              <>
                <form method="post" action={`/dashboard/agents/${agent.id}/risk/${flag.id}/review`} aria-label="Request review">
                  <label htmlFor={`note-${flag.id}`} className="sr-only">
                    Review note
                  </label>
                  <input
                    className="ui-input"
                    id={`note-${flag.id}`}
                    name="note"
                    maxLength={500}
                    placeholder="Why this is legitimate (optional)"
                  />
                  <button type="submit" className="ui-btn">
                    {flag.reviewRequestedAt ? "Update review request" : "Request review"}
                  </button>
                </form>
                {agent.canClearRiskFlags ? (
                  <form method="post" action={`/dashboard/agents/${agent.id}/risk/${flag.id}/clear`}>
                    <button type="submit" className="ui-btn">
                      Clear flag (your sandbox world)
                    </button>
                  </form>
                ) : null}
              </>
            ) : null}
            <small>Raised {formatDateTime(flag.firstSimAt)} · bank time</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** P3 Task 4: the adverse-action notices of the latest declined applications (plain text). */
function DeclinesSection({ agent }: { agent: AgentDetailView }) {
  if (agent.declines.length === 0) {
    return null;
  }
  return (
    <section className="ds" id="declines" aria-labelledby="declines-h">
      <h3 id="declines-h">Recent declines</h3>
      <ul className="tl" data-testid="declines">
        {agent.declines.map((decline) => (
          <li key={decline.id} className="risk">
            {formatCents(decline.amountCents)} for {decline.termDays} days
            {decline.grade ? ` · score ${decline.score ?? "?"}, grade ${decline.grade}` : ""}
            <ul>
              {decline.reasons.map((reason) => (
                <li key={reason.code}>{reason.text}</li>
              ))}
            </ul>
            {decline.explanation ? <small>{decline.explanation}</small> : null}
            <small>{formatDateTime(decline.createdAt)}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The KYA desk's findings as plain text (React escapes it; URLs were stripped before storing). */
function aiFindingsText(findings: unknown): string {
  return Array.isArray(findings) ? findings.filter((f): f is string => typeof f === "string").join(" · ") : "";
}

function DocumentsSection({ agent }: { agent: AgentDetailView }) {
  return (
    <section className="ds" id="documents" aria-labelledby="docs-h">
      <h3 id="docs-h">KYA documents</h3>
      {agent.documents.length ? (
        <ul className="doclist" data-testid="documents">
          {agent.documents.map((doc) => (
            <li key={doc.id}>
              <div>
                <b>{doc.fileName ?? DOC_KIND_LABEL[doc.kind] ?? doc.kind}</b>
                <small>
                  {DOC_KIND_LABEL[doc.kind] ?? doc.kind} · {doc.sizeBytes ? `${Math.max(1, Math.round(doc.sizeBytes / 1024))} KB` : ""} ·{" "}
                  {formatDate(doc.createdAt)}
                </small>
                {doc.aiVerdict ? (
                  <small className="ai-review" data-testid="ai-review" title={aiFindingsText(doc.aiFindings)}>
                    <Pill tone={doc.aiVerdict === "approve" ? "ok" : doc.aiVerdict === "reject" ? "risk" : "warn"}>
                      AI review: {doc.aiVerdict}
                    </Pill>{" "}
                    advisory
                  </small>
                ) : null}
              </div>
              <Pill tone={doc.reviewStatus === "approved" ? "ok" : doc.reviewStatus === "rejected" ? "risk" : "warn"}>
                {doc.reviewStatus}
              </Pill>
              <form method="post" action={`/dashboard/agents/${agent.id}/documents/${doc.id}`}>
                <button type="submit" className="ui-btn ghost" aria-label={`Delete ${doc.fileName ?? "document"}`}>
                  Delete
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">
          No documents yet. One approved document plus a signing key lifts {agent.name} to T2 (loans up to $500.00).
        </p>
      )}
      <form className="upload" method="post" action={`/dashboard/agents/${agent.id}/documents`} encType="multipart/form-data">
        <div className="row">
          <label className="sr-only" htmlFor="doc-kind">
            Document type
          </label>
          <select className="ui-input" id="doc-kind" name="kind" defaultValue="operator_registration">
            {KYA_DOCUMENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {DOC_KIND_LABEL[kind]}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="doc-file">
            File (PDF, PNG or JPEG, up to 2 MB)
          </label>
          <input id="doc-file" name="file" type="file" accept="application/pdf,image/png,image/jpeg" required />
        </div>
        <button type="submit" className="ui-btn">
          Upload document
        </button>
        <span className="hint">
          PDF, PNG or JPEG, up to 2 MB.
        </span>
      </form>
    </section>
  );
}

function KeysSection({ agent }: { agent: AgentDetailView }) {
  const frozen = agent.status === "frozen";
  return (
    <section className="ds" id="keys" aria-labelledby="keys-h">
      <h3 id="keys-h">Keys and access</h3>
      <div className="keyrow">
        <div>
          <b>Signing key (Ed25519)</b>
          {agent.signingKey ? (
            <p className="mono" data-testid="key-fingerprint">
              ed25519 · {agent.signingKey.fingerprint} · added {formatDate(agent.signingKey.createdAt)}
            </p>
          ) : (
            <p data-testid="no-signing-key">None registered. The agent registers one with register_public_key.</p>
          )}
        </div>
        {agent.signingKey ? (
          <form method="post" action={`/dashboard/agents/${agent.id}/key/revoke`}>
            <button type="submit" className="ui-btn danger">
              Revoke signing key
            </button>
          </form>
        ) : null}
      </div>
      <div className="keyrow">
        <div>
          <b>API key</b>
          <p>
            {agent.apiKey ? (
              <>
                <span className="mono">mnd_{agent.apiKey.prefix}_••••</span>
                {agent.apiKey.readOnly ? <span data-testid="key-read-only"> · read-only</span> : null} · created{" "}
                {formatDate(agent.apiKey.createdAt)}
                {agent.apiKey.lastUsedAt ? ` · last used ${formatDate(agent.apiKey.lastUsedAt)}` : " · never used"}
              </>
            ) : (
              "No active key."
            )}
          </p>
        </div>
        <form method="post" action={`/dashboard/agents/${agent.id}/api-key/rotate`}>
          <label className="check">
            <input type="checkbox" name="read_only" value="on" data-testid="rotate-read-only" /> Read-only key
          </label>{" "}
          <button type="submit" className="ui-btn">
            Rotate API key
          </button>
        </form>
      </div>
      <div className="keyrow">
        <div>
          <b>{frozen ? "Agent is frozen" : "Freeze agent"}</b>
          <p>
            {frozen
              ? "Its calls that move money are refused. Loans and notes are untouched."
              : "Stops it borrowing, lending or repaying through tools until you unfreeze it."}
          </p>
        </div>
        {agent.status === "active" || agent.status === "restricted" || frozen ? (
          <form method="post" action={`/dashboard/agents/${agent.id}/${frozen ? "unfreeze" : "freeze"}`}>
            <button type="submit" className="ui-btn danger">
              {frozen ? "Unfreeze agent" : "Freeze agent"}
            </button>
          </form>
        ) : null}
      </div>
    </section>
  );
}

export function AgentDrawer({
  agent,
  tab,
  params,
  closeHref = "/dashboard",
}: {
  agent: AgentDetailView;
  tab: DrawerTab;
  params: DrawerParams;
  closeHref?: string;
}) {
  const pill = STATUS_PILL[agent.display];
  return (
    <aside className="drawer" id="agent-drawer" aria-labelledby="drawer-title" tabIndex={-1} data-testid="agent-drawer">
      <DrawerKeys closeHref={closeHref} />
      <div className="dh">
        <div className="row">
          <h2 id="drawer-title">{agent.name}</h2>
          <span data-testid="drawer-status">
            <Pill tone={pill.tone}>{pill.label}</Pill>
          </span>
          <Link className="ui-btn ghost x" href={closeHref} aria-label="Close details" scroll={false}>
            <IconX size={14} />
          </Link>
        </div>
        <p>
          {agent.operator} · {agent.model} · <span className="mono">agt_{shortId(agent.id)}</span> · score {agent.credit.score} ·{" "}
          {agent.credit.grade}
        </p>
      </div>
      <Notices params={params} />
      <KyaSection agent={agent} />
      <MandateSection agent={agent} params={params} />
      <Tabs agent={agent} tab={tab} />
      <RiskSection agent={agent} />
      <DeclinesSection agent={agent} />
      <DocumentsSection agent={agent} />
      <KeysSection agent={agent} />
      <div className="ui-legal dlegal">{LEGAL}</div>
    </aside>
  );
}
