import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { requirePagePrincipal } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { agentDetail, ownerDashboard } from "@/server/services/dashboard";
import { resolveDashboardWorld } from "@/server/services/privateWorldAccess";

import { AgentCard, PasteClaimCard, SummaryStrip } from "./_components/cards";
import { DashFrame, LEGAL, LoadingFrame, TopBar } from "./_components/chrome";
import { AgentDrawer, type DrawerParams, type DrawerTab } from "./_components/drawer";
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
 * `/dashboard` — the owner dashboard (P2 Task 5, design
 * docs/design/owner-dashboard-v1.html): the principal's agents as cards
 * with a summary strip, and `?agent=<id>` opens that agent's detail
 * drawer (a URL state, so it works without JS and can be linked). An id
 * that isn't one of the principal's agents opens nothing.
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
  const tab: DrawerTab = TABS.includes(params.tab as DrawerTab) ? (params.tab as DrawerTab) : "loans";

  return (
    <DashFrame hasDrawer={Boolean(detail)}>
      <TopBar principalId={session.principalId} worldId={privateWorldId} />
      <main className="page" id="main">
        {privateWorldId ? (
          <div className="world-banner" data-testid="world-banner">
            <span className="grow">
              <b>Sandbox world · {world.name}</b> — simulated money on the sim rail; never PayPal.
            </span>
            <Link href={`/dashboard/worlds/${privateWorldId}`}>Clock &amp; bots →</Link>
            <Link href="/dashboard">Main world</Link>
          </div>
        ) : null}
        <div className="head">
          <div>
            <h1>Your agents</h1>
            <p className="sub">
              Agents you have claimed borrow under the mandate you signed. You can change or revoke it at any time.
            </p>
          </div>
          <div className="clock">
            <Link className="btn" href="/dashboard/worlds">
              Sandbox worlds
            </Link>
            <Link className="btn primary" href={`/dashboard/agents/new${worldQuery}`}>
              + Register an agent
            </Link>
          </div>
        </div>

        {params.agent && !detail ? (
          <div className="notice err" role="alert">
            That agent isn&apos;t one of yours.
          </div>
        ) : null}

        <SummaryStrip summary={summary} />

        <section className="grid" aria-label="Agents">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} selected={agent.id === detail?.id} />
          ))}
          <PasteClaimCard error={params.claim_error === "invalid"} />
        </section>

        {agents.length === 0 ? (
          <p className="sub" style={{ marginTop: 16 }}>
            {privateWorldId
              ? "No agents of yours in this sandbox world yet. Register one here; the bots are already trading."
              : "No agents yet. Register one here, or open the claim link your agent gave you."}
          </p>
        ) : null}

        <p className="pagelegal">{LEGAL}</p>
      </main>
      {detail ? <AgentDrawer agent={detail} tab={tab} params={params} closeHref={`/dashboard${worldQuery}`} /> : null}
    </DashFrame>
  );
}

export default function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<LoadingFrame />}>
      <Dashboard searchParams={searchParams} />
    </Suspense>
  );
}
