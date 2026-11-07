import type { GuaranteeView, OwnerNoticeView } from "@/server/services/dashboard";

import { drawerHref } from "./cards";
import { Pill, type Tone } from "./chrome";
import { approveHref, formatCents, formatDateTime, loanLabel } from "./format";

/**
 * P4 Task 4: what the owner sees about collections on `/dashboard` — the
 * guarantee they owe on a charged-off loan, and the notices about their
 * agents' loans (with the owner's own read state).
 */

/** "Your agent's loan was charged off. As guarantor you owe $X." + the pay link, as a quiet notice row. */
export function GuaranteeCards({ guarantees, privateWorld }: { guarantees: GuaranteeView[]; privateWorld: boolean }) {
  if (guarantees.length === 0) {
    return null;
  }
  return (
    <>
      {guarantees.map((g) => {
        const payable = g.link?.status === "open" && g.link.approveUrl;
        return (
          <section className="guarantee" key={g.loanId} data-testid="guarantee-card" aria-labelledby={`g-${g.loanId}`}>
            <span className="ui-st risk" aria-hidden="true" />
            <div>
              <h2 id={`g-${g.loanId}`}>
                {g.agentName}&apos;s loan {loanLabel(g.loanId)} was charged off.
              </h2>
              <p>
                As guarantor you owe{" "}
                <b className="num" data-testid="guarantee-owed">
                  {formatCents(g.owedCents)}
                </b>
                . Paying it recovers the loan, makes the note holders whole and lifts your agent&apos;s restriction and your
                mandate freeze. <a href={drawerHref(g.agentId)}>Loan details</a>
              </p>
            </div>
            {payable ? (
              <a className="ui-btn primary" href={approveHref(g.link!.approveUrl!)} data-testid="guarantee-pay">
                {privateWorld ? `Pay ${formatCents(g.link!.amountCents)} (simulated)` : "Pay with PayPal"}
              </a>
            ) : (
              <span className="faint">
                {g.link?.status === "captured" || g.link?.status === "approved"
                  ? "Payment received — settling."
                  : "Your payment link is being prepared. Refresh in a moment."}
              </span>
            )}
          </section>
        );
      })}
    </>
  );
}

const NOTICE_KIND: Record<string, { tone: Tone; label: string }> = {
  late: { tone: "warn", label: "Late" },
  penalty: { tone: "warn", label: "Penalty" },
  substandard: { tone: "risk", label: "Substandard" },
  charged_off: { tone: "dark", label: "Charged off" },
  recovery: { tone: "blue", label: "Recovery" },
  recovered: { tone: "ok", label: "Recovered" },
  cured: { tone: "ok", label: "Cured" },
  installment_missed: { tone: "warn", label: "Installment missed" },
  installment_rescheduled: { tone: "blue", label: "Installment moved" },
  installment_failed: { tone: "risk", label: "Payment failed" },
};

export function NoticesPanel({
  notices,
  unread,
  worldId,
}: {
  notices: OwnerNoticeView[];
  unread: number;
  worldId?: string;
}) {
  return (
    <section className="notices" id="notices" aria-labelledby="notices-h" data-testid="notices-panel">
      <div className="sec-h">
        <h2 id="notices-h">
          Notices{" "}
          {unread > 0 ? (
            <span className="unread num" data-testid="notices-unread">
              {unread} unread
            </span>
          ) : null}
        </h2>
        {unread > 0 ? (
          <form method="post" action="/dashboard/notices/read">
            {worldId ? <input type="hidden" name="world" value={worldId} /> : null}
            <button type="submit" className="ui-btn">
              Mark all read
            </button>
          </form>
        ) : null}
      </div>
      {notices.length === 0 ? (
        <p className="empty">
          No notices. If one of your agents&apos; loans goes past due, the bank tells you here (and tells the agent).
        </p>
      ) : (
        <ul className="nlist" data-testid="notices-list">
          {notices.map((n) => {
            const kind = NOTICE_KIND[n.kind] ?? { tone: "plain" as const, label: n.kind };
            return (
              <li key={n.id} className={n.ownerReadAt ? "" : "unread"} data-testid="notice">
                <span className="nk">
                  <Pill tone={kind.tone}>{kind.label}</Pill>
                </span>
                <div>
                  <b>{n.agentName}</b>
                  {n.loanId ? (
                    <>
                      {" "}
                      · <span className="mono">{loanLabel(n.loanId)}</span>
                    </>
                  ) : null}
                  <div className="nb">{n.body}</div>
                  <small>{formatDateTime(n.simAt)} · bank time</small>
                </div>
                {n.ownerReadAt ? (
                  <span className="sr-only">read</span>
                ) : (
                  <form method="post" action="/dashboard/notices/read">
                    <input type="hidden" name="notice_id" value={n.id} />
                    {worldId ? <input type="hidden" name="world" value={worldId} /> : null}
                    <button type="submit" className="ui-btn ghost" aria-label={`Mark notice about ${n.agentName} read`}>
                      Mark read
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
