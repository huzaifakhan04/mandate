import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { MandateMark } from "@/components/brand/MandateLogo";
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

const LEGAL = "Sandbox model · simulated money · notes are not deposits and not FDIC-insured";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col bg-surface">
      <header className="flex h-15 items-center gap-2 border-b border-ink/10 bg-background px-4 sm:px-6">
        <MandateMark size={28} variant="tile" className="rounded-lg" />
        <span className="text-[17px] font-bold tracking-tight text-ink">Mandate</span>
      </header>
      <div className="flex flex-1 items-start justify-center px-4 py-10 sm:items-center sm:py-16">
        <main className="w-full max-w-md rounded-2xl border border-ink/10 bg-background p-6 shadow-[0_1px_2px_rgba(21,24,29,.04),0_4px_16px_rgba(21,24,29,.06)] sm:p-8">
          {children}
          <p className="mt-8 text-center text-[11px] text-ink/45">{LEGAL}</p>
        </main>
      </div>
    </div>
  );
}

type Tone = "blue" | "ok" | "warn" | "risk";

const PILL: Record<Tone, string> = {
  blue: "bg-accent/10 text-accent",
  ok: "bg-money-in/10 text-money-in",
  warn: "bg-amber-50 text-amber-700",
  risk: "bg-risk/10 text-risk",
};

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-bold tracking-wide ${PILL[tone]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

function AgentCard({ agent, tone, label }: { agent: ClaimAgentSummary; tone: Tone; label: string }) {
  return (
    <div className="mt-5 rounded-xl border border-ink/10 p-4">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-accent text-base font-bold text-white">
          {agent.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-ink" data-testid="agent-name">
            {agent.name}
          </h2>
          <p className="truncate text-xs text-ink/50">AI agent</p>
        </div>
        <span className="ml-auto">
          <Pill tone={tone}>{label}</Pill>
        </span>
      </div>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-ink/55">Operator</dt>
        <dd className="min-w-0 text-right font-semibold [overflow-wrap:anywhere]">{agent.operator}</dd>
        <dt className="text-ink/55">Model</dt>
        <dd className="min-w-0 text-right font-semibold [overflow-wrap:anywhere]">{agent.model}</dd>
      </dl>
    </div>
  );
}

const PRIMARY =
  "block w-full rounded-xl bg-accent px-4 py-3 text-center text-base font-semibold text-white hover:bg-accent/90";
const SECONDARY =
  "block w-full rounded-xl border border-ink/15 px-4 py-3 text-center text-base font-semibold text-ink hover:bg-surface";

function Heading({ children }: { children: React.ReactNode }) {
  return <h1 className="text-2xl font-semibold tracking-tight text-ink">{children}</h1>;
}

function Lead({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-[15px] leading-relaxed text-ink/65">{children}</p>;
}

function ClaimState({ state, token }: { state: ClaimView; token: string }) {
  switch (state.view) {
    case "invalid":
      return (
        <div data-testid="claim-invalid">
          <Pill tone="risk">INVALID LINK</Pill>
          <div className="mt-3">
            <Heading>This claim link doesn&apos;t work</Heading>
          </div>
          <Lead>
            Check that you copied the whole link. Your agent can show its current claim link again — ask it to call{" "}
            <code className="font-mono text-sm">get_status</code>.
          </Lead>
        </div>
      );
    case "expired":
      return (
        <div data-testid="claim-expired">
          <Pill tone="warn">EXPIRED</Pill>
          <div className="mt-3">
            <Heading>This claim link has expired</Heading>
          </div>
          <Lead>
            Claim links last 7 days. Ask {state.agent.name} for a fresh one — it gets a new link from{" "}
            <code className="font-mono text-sm">get_status</code>.
          </Lead>
          <AgentCard agent={state.agent} tone="warn" label="UNCLAIMED" />
        </div>
      );
    case "sign_in":
      return (
        <div data-testid="claim-sign-in">
          <Heading>Claim {state.agent.name}</Heading>
          <Lead>
            An AI agent asked you to become its owner. Owning it lets you set what it may borrow. First, verify who you
            are with PayPal — a $0.01 check that is never charged.
          </Lead>
          <AgentCard agent={state.agent} tone="warn" label="UNCLAIMED" />
          <form method="post" action="/verify/start" className="mt-6">
            <input type="hidden" name="return_to" value={`/claim/${token}`} />
            <button type="submit" className={PRIMARY}>
              Verify with PayPal to claim {state.agent.name}
            </button>
          </form>
        </div>
      );
    case "confirm":
      return (
        <div data-testid="claim-confirm">
          <Heading>Claim {state.agent.name}?</Heading>
          <Lead>
            You&apos;ll become this agent&apos;s owner. It can lend right away; it can borrow only after you sign a
            mandate that sets its limits.
          </Lead>
          <AgentCard agent={state.agent} tone="warn" label="UNCLAIMED" />
          <form method="post" action={`/claim/${token}/accept`} className="mt-6">
            <button type="submit" className={PRIMARY}>
              Claim agent
            </button>
          </form>
        </div>
      );
    case "yours":
      return (
        <div data-testid="claim-yours">
          <Pill tone="ok">CLAIMED</Pill>
          <div className="mt-3">
            <Heading>{state.agent.name} is yours</Heading>
          </div>
          <Lead>Next, sign a mandate in your dashboard so your agent can borrow within the limits you set.</Lead>
          <AgentCard agent={state.agent} tone="ok" label="YOURS" />
          <Link href="/dashboard" className={`mt-6 ${PRIMARY}`}>
            Go to dashboard
          </Link>
        </div>
      );
    case "taken":
      return (
        <div data-testid="claim-taken">
          <Pill tone="risk">409 · ALREADY CLAIMED</Pill>
          <div className="mt-3">
            <Heading>This agent has already been claimed</Heading>
          </div>
          <Lead>
            Another verified PayPal account owns {state.agent.name}, so it can&apos;t be claimed again.
          </Lead>
          <Link href="/dashboard" className={`mt-6 ${SECONDARY}`}>
            Go to your dashboard
          </Link>
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
    <Shell>
      <Suspense fallback={<p className="text-base text-ink/60">Loading…</p>}>
        <ClaimContent params={params} />
      </Suspense>
    </Shell>
  );
}
