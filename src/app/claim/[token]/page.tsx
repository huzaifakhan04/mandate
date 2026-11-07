import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AuthActions, AuthHeading, AuthLead, AuthShell, AuthVia } from "@/components/ui/auth-shell";
import { IconShield } from "@/components/ui/icons";
import { getPagePrincipal } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { claimView, type ClaimAgentSummary, type ClaimView } from "@/server/services/claims";

/**
 * `/claim/<token>` — where a human claims the agent that sent them the
 * link (P2 Task 2, path A). States: invalid / expired link; not signed in
 * (Verify with PayPal, returning here); signed in (agent details + "Claim
 * agent"); claimed by you; claimed by someone else. The token is a
 * bearer secret: it is never logged, and `Referrer-Policy: same-origin`
 * keeps it out of the Referer sent to PayPal or any other site, while the
 * page's own form POSTs (Verify / Claim) still carry a real `Origin`
 * header for the same-origin CSRF check (P2 final review, M1).
 */
export const metadata: Metadata = {
  title: "Mandate · Claim your agent",
  robots: { index: false, follow: false },
  referrer: "same-origin",
};

type Tone = "ok" | "warn" | "risk";

/** Glyph + label status (`.ui-st`), sentence case. */
function Status({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`ui-st ${tone}`}>{children}</span>;
}

/** The agent in hairline rows: name + status, then operator / model / agent ID. */
function AgentSummary({ agent, tone, label }: { agent: ClaimAgentSummary; tone: Tone; label: string }) {
  return (
    <section aria-label="Agent" className="border-y border-line py-3">
      <div className="mb-2.5 flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className="grid size-[22px] flex-none place-items-center rounded-full border border-line-2 text-[11px] font-medium text-t2"
        >
          {agent.name.slice(0, 1).toUpperCase()}
        </span>
        <h2 className="m-0 min-w-0 truncate text-[13px] font-medium text-t1" data-testid="agent-name">
          {agent.name}
        </h2>
        <span className="text-xs text-t3">AI agent</span>
        <span className="ml-auto">
          <Status tone={tone}>{label}</Status>
        </span>
      </div>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12.5px]">
        <dt className="text-t3">Operator</dt>
        <dd className="m-0 text-right text-t2 [overflow-wrap:anywhere]">{agent.operator}</dd>
        <dt className="text-t3">Model</dt>
        <dd className="m-0 text-right text-t2 [overflow-wrap:anywhere]">{agent.model}</dd>
        <dt className="text-t3">Agent ID</dt>
        <dd className="m-0 text-right font-mono text-xs text-t2 [overflow-wrap:anywhere]">{agent.id}</dd>
      </dl>
    </section>
  );
}

const LIMITS: { label: string; detail: string }[] = [
  { label: "Max per loan", detail: "the most it may borrow in one loan" },
  { label: "Max total owed", detail: "its ceiling across every open loan" },
  { label: "Max fee", detail: "the highest fee it may accept" },
  { label: "Max term", detail: "the longest loan it may take" },
];

/** What the owner signs next: the mandate's four fields, described (values are set on the dashboard). */
function NextLimits() {
  return (
    <section aria-labelledby="limits-h">
      <h2 id="limits-h" className="m-0 mb-2 text-xs font-normal text-t3">
        You&apos;ll set these limits next, in the mandate you sign
      </h2>
      <dl className="m-0 grid grid-cols-2 border-t border-line">
        {LIMITS.map((limit, i) => (
          <div
            key={limit.label}
            className={`border-b border-line py-2.5 text-[12.5px] ${
              i % 2 === 1 ? "border-l border-line pl-3" : "pr-3"
            }`}
          >
            <dt className="font-medium text-t1">{limit.label}</dt>
            <dd className="m-0 text-xs text-t3">{limit.detail}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-xs text-t1">{children}</code>;
}

function Top({ status, children }: { status?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      {status ? <div className="mb-3">{status}</div> : null}
      {children}
    </div>
  );
}

function ClaimState({ state, token }: { state: ClaimView; token: string }) {
  switch (state.view) {
    case "invalid":
      return (
        <div data-testid="claim-invalid" className="flex flex-col gap-5">
          <Top status={<Status tone="risk">Invalid link</Status>}>
            <AuthHeading>This claim link doesn&apos;t work</AuthHeading>
            <AuthLead>
              Check that you copied the whole link. Your agent can show its current claim link again — ask it to call{" "}
              <Code>get_status</Code>.
            </AuthLead>
          </Top>
        </div>
      );
    case "expired":
      return (
        <div data-testid="claim-expired" className="flex flex-col gap-5">
          <Top status={<Status tone="warn">Expired</Status>}>
            <AuthHeading>This claim link has expired</AuthHeading>
            <AuthLead>
              Claim links last 7 days. Ask {state.agent.name} for a fresh one — it gets a new link from{" "}
              <Code>get_status</Code>.
            </AuthLead>
          </Top>
          <AgentSummary agent={state.agent} tone="warn" label="Unclaimed" />
        </div>
      );
    case "sign_in":
      return (
        <div data-testid="claim-sign-in" className="flex flex-col gap-5">
          <Top>
            <AuthHeading>Claim {state.agent.name}</AuthHeading>
            <p className="m-0 mt-1 text-xs text-t4">Step 1 of 2 · verify who you are</p>
            <AuthLead>
              An AI agent asked you to become its owner. Owning it lets you set what it may borrow. First, verify who
              you are with PayPal — a $0.01 check that is never charged.
            </AuthLead>
          </Top>
          <AgentSummary agent={state.agent} tone="warn" label="Unclaimed" />
          <NextLimits />
          <AuthActions>
            <form method="post" action="/verify/start">
              <input type="hidden" name="return_to" value={`/claim/${token}`} />
              <button type="submit" className="ui-btn primary lg">
                Verify with PayPal to claim {state.agent.name}
              </button>
            </form>
          </AuthActions>
          <AuthVia>
            <IconShield size={14} />
            via PayPal · sandbox · no real money moves
          </AuthVia>
        </div>
      );
    case "confirm":
      return (
        <div data-testid="claim-confirm" className="flex flex-col gap-5">
          <Top>
            <AuthHeading>Claim {state.agent.name}?</AuthHeading>
            <p className="m-0 mt-1 text-xs text-t4">Step 2 of 2 · confirm</p>
            <AuthLead>
              You&apos;ll become this agent&apos;s owner. It can lend right away; it can borrow only after you sign a
              mandate that sets its limits.
            </AuthLead>
          </Top>
          <AgentSummary agent={state.agent} tone="warn" label="Unclaimed" />
          <NextLimits />
          <AuthActions>
            <form method="post" action={`/claim/${token}/accept`}>
              <button type="submit" className="ui-btn primary lg">
                Claim agent
              </button>
            </form>
          </AuthActions>
          <AuthVia>Next: sign a mandate in your dashboard.</AuthVia>
        </div>
      );
    case "yours":
      return (
        <div data-testid="claim-yours" className="flex flex-col gap-5">
          <Top status={<Status tone="ok">Claimed</Status>}>
            <AuthHeading>{state.agent.name} is yours</AuthHeading>
            <AuthLead>Next, sign a mandate in your dashboard so your agent can borrow within the limits you set.</AuthLead>
          </Top>
          <AgentSummary agent={state.agent} tone="ok" label="Yours" />
          <NextLimits />
          <AuthActions>
            <Link href="/dashboard" className="ui-btn primary lg">
              Go to dashboard
            </Link>
          </AuthActions>
        </div>
      );
    case "taken":
      return (
        <div data-testid="claim-taken" className="flex flex-col gap-5">
          <Top status={<Status tone="risk">409 · Already claimed</Status>}>
            <AuthHeading>This agent has already been claimed</AuthHeading>
            <AuthLead>
              Another verified PayPal account owns {state.agent.name}, so it can&apos;t be claimed again.
            </AuthLead>
          </Top>
          <AuthActions>
            <Link href="/dashboard" className="ui-btn lg">
              Go to your dashboard
            </Link>
          </AuthActions>
        </div>
      );
  }
}

async function ClaimContent({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await getPagePrincipal();
  const state = await claimView(await getDb(), token, session?.principalId ?? null);
  return <ClaimState state={state} token={token} />;
}

export default function ClaimPage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <AuthShell>
      <Suspense fallback={<p className="m-0 text-[13px] text-t3">Loading…</p>}>
        <ClaimContent params={params} />
      </Suspense>
    </AuthShell>
  );
}
