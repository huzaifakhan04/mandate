import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { requirePagePrincipal } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { agentDetail, guaranteesOwed, ownerDashboard, ownerNotices } from "@/server/services/dashboard";
import { resolveDashboardWorld } from "@/server/services/privateWorldAccess";
import { ownerTimeline } from "@/server/services/timeline";

import { AgentCard, AgentListHead, PasteClaimCard, SummaryStrip } from "./_components/cards";
import { Crumb, LEGAL, LoadingFrame, OwnerShell } from "./_components/chrome";
import { GuaranteeCards, NoticesPanel } from "./_components/collections";
import { AgentDrawer, type DrawerParams, type DrawerTab } from "./_components/drawer";
import { TimelinePanel } from "./_components/timeline-panel";
import "./dashboard.css";

export const metadata: Metadata = {
  title: "Mandate · Your agents",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function flatten(params: Record<string, string | string[] | undefined>): DrawerParams {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
  );
}

const TABS: readonly DrawerTab[] = ["loans", "notes", "events"];

/**
 * `/dashboard` — the owner dashboard: the principal's agents as a dense
 * list with a one-line summary, and `?agent=<id>` opens that agent's
 * detail drawer (a URL state, so it works without JS and can be linked).
 * An id that isn't one of the principal's agents opens nothing.
 */
async function Dashboard({ searchParams }: { searchParams: SearchParams }) {
  const params = flatten(await searchParams);
  const returnTo = params.agent ? `/dashboard?agent=${encodeURIComponent(params.agent)}` : "/dashboard";
  const session = await requirePagePrincipal(returnTo);
  const db = await getDb();
  const detail = params.agent ? await agentDetail(db, session.principalId, params.agent) : null;
  // P2 Task 6: the selected world — `?world=<id>` (one of my private
  // worlds), else the open agent's world, else main.
  const world = await resolveDashboardWorld(db, session.principalId, params.world ?? detail?.worldId);
  const privateWorldId = world.kind === "private" ? world.id : undefined;
  const { summary, agents } = await ownerDashboard(db, session.principalId, new Date(), { worldId: privateWorldId });
  const worldQuery = privateWorldId ? `?world=${privateWorldId}` : "";
  const notices = await ownerNotices(db, session.principalId, { worldId: privateWorldId });
  const guarantees = guaranteesOwed(agents);
  const tab: DrawerTab = TABS.includes(params.tab as DrawerTab) ? (params.tab as DrawerTab) : "loans";
  // P7: `?view=timeline` — the Bryntum repayment timeline instead of the agent list.
  const view = params.view === "timeline" ? "timeline" : "agents";
  const timeline = view === "timeline" ? await ownerTimeline(db, session.principalId, { worldId: privateWorldId }) : null;

  const crumb = (
    <Crumb
      items={[
        { label: view === "timeline" ? "Timeline" : "Your agents", href: detail ? `/dashboard${worldQuery}` : undefined },
        ...(detail ? [{ label: detail.name }] : []),
      ]}
    />
  );

  return (
    <OwnerShell
      principalId={session.principalId}
      worldId={privateWorldId}
      current={view}
      crumb={crumb}
      agentCount={agents.length}
      hasDrawer={Boolean(detail)}
      drawer={detail ? <AgentDrawer agent={detail} tab={tab} params={params} closeHref={`/dashboard${worldQuery}`} /> : null}
    >
      <div className="dl">
        {privateWorldId ? (
          <div className="world-banner" data-testid="world-banner">
            <span className="ui-st sim" aria-hidden="true" />
            <span className="grow">
              Sandbox world · <b>{world.name}</b> — simulated money on the sim rail; never PayPal.
            </span>
            <span className="r">
              <Link href={`/dashboard/worlds/${privateWorldId}`}>Clock and bots</Link>
              <Link href="/dashboard">Main world</Link>
            </span>
          </div>
        ) : null}
        <div className="ph">
          <div>
            <h1>Your agents</h1>
            <p>Agents you have claimed borrow under the mandate you signed. You can change or revoke it at any time.</p>
          </div>
          <div className="r">
            <Link className="ui-btn" href="/dashboard/worlds">
              Sandbox worlds
            </Link>
            <Link className="ui-btn primary" href={`/dashboard/agents/new${worldQuery}`}>
              + Register an agent
            </Link>
          </div>
        </div>

        {params.agent && !detail ? (
          <div className="notice err" role="alert">
            That agent isn&apos;t one of yours.
          </div>
        ) : null}

        <GuaranteeCards guarantees={guarantees} privateWorld={Boolean(privateWorldId)} />

        {timeline ? (
          <TimelinePanel initial={timeline} worldId={privateWorldId} licenseKey={process.env.BRYNTUM_LICENSE_KEY ?? null} />
        ) : (
          <>
            <SummaryStrip summary={summary} />

            <section className="alist" aria-label="Agents">
              {agents.length > 0 ? <AgentListHead /> : null}
              {agents.map((agent) => (
                <AgentCard key={agent.id} agent={agent} selected={agent.id === detail?.id} />
              ))}
              {agents.length === 0 ? (
                <p className="empty">
                  {privateWorldId
                    ? "No agents of yours in this sandbox world yet. Register one here; the bots are already trading."
                    : "No agents yet. Register one here, or open the claim link your agent gave you."}
                </p>
              ) : null}
            </section>
            <PasteClaimCard error={params.claim_error === "invalid"} />
          </>
        )}

        <NoticesPanel notices={notices.notices} unread={notices.unread} worldId={privateWorldId} />

        <p className="ui-legal pagelegal">{LEGAL}</p>
      </div>
    </OwnerShell>
  );
}

export default function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<LoadingFrame />}>
      <Dashboard searchParams={searchParams} />
    </Suspense>
  );
}
