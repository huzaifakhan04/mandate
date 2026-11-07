import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { getPagePrincipal } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import {
  cachedConsoleSnapshot,
  consoleWorldChoices,
  consoleWorldParam,
  defaultConsoleWorld,
  resolveConsoleWorld,
} from "@/server/services/console";

import { MandateLogo } from "@/components/brand/MandateLogo";

import { ConsoleApp } from "./_components/console-app";
import "./console.css";

export const metadata: Metadata = {
  title: "Mandate · Mission control",
  description: "Watch the Mandate sandbox bank live: clock, KPIs, money flow, PayPal API log and ledger.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * `/console` — the public, read-only bank console ("mission control", P6;
 * design v2). Everyone lands on the main world (the real PayPal sandbox);
 * anyone may switch to the public demo world (`?world=demo`, simulated
 * money, auto-advanced); a signed-in owner may also switch to one of their own private
 * sandbox worlds (`?world=<id>`) and move its clock. Someone else's world → 404. The
 * first snapshot is rendered on the server; the client then polls
 * `/api/console/snapshot` every 2 s while the tab is visible.
 */
async function ConsolePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const requested = Array.isArray(params.world) ? params.world[0] : params.world;
  const session = await getPagePrincipal();
  const principalId = session?.principalId ?? null;
  const db = await getDb();
  const world = await resolveConsoleWorld(db, principalId, requested || defaultConsoleWorld());
  if (!world) {
    notFound();
  }
  const [snapshot, choices] = await Promise.all([cachedConsoleSnapshot(db, world), consoleWorldChoices(db, principalId)]);
  return (
    <ConsoleApp
      initial={snapshot}
      worldParam={consoleWorldParam(world)}
      choices={choices}
      licenseKey={process.env.BRYNTUM_LICENSE_KEY ?? null}
    />
  );
}

function Loading() {
  return (
    <div className="shell mc">
      <aside className="shell-side" aria-label="Console">
        <span className="shell-brand">
          <MandateLogo size={16} />
        </span>
      </aside>
      <div className="shell-main">
        <header className="shell-head">
          <span className="crumb">Mission control</span>
        </header>
        <main className="shell-body" aria-busy="true">
          <p className="world-line">Loading the bank…</p>
        </main>
      </div>
    </div>
  );
}

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<Loading />}>
      <ConsolePage searchParams={searchParams} />
    </Suspense>
  );
}
