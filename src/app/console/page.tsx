import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { getPagePrincipal } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { consoleSnapshot, consoleWorldChoices, resolveConsoleWorld } from "@/server/services/console";

import { ConsoleApp } from "./_components/console-app";
import "./console.css";

export const metadata: Metadata = {
  title: "Mandate · Mission control",
  description: "Watch the Mandate sandbox bank live: clock, KPIs, money flow, PayPal API log and ledger.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * `/console` — the public, read-only bank console ("mission control", P6;
 * design docs/design/console-v2.html). Anyone sees the main world; a
 * signed-in owner may switch to one of their own private sandbox worlds
 * (`?world=<id>`) and move its clock. Someone else's world → 404. The
 * first snapshot is rendered on the server; the client then polls
 * `/api/console/snapshot` every 2 s while the tab is visible.
 */
async function ConsolePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const requested = Array.isArray(params.world) ? params.world[0] : params.world;
  const session = await getPagePrincipal();
  const principalId = session?.principalId ?? null;
  const db = await getDb();
  const world = await resolveConsoleWorld(db, principalId, requested);
  if (!world) {
    notFound();
  }
  const [snapshot, choices] = await Promise.all([consoleSnapshot(db, world), consoleWorldChoices(db, principalId)]);
  return <ConsoleApp initial={snapshot} worldParam={world.kind === "main" ? "main" : world.id} choices={choices} />;
}

function Loading() {
  return (
    <div className="mc">
      <header className="top">
        <span className="brand">
          <i aria-hidden="true">M</i>Mandate <em>· Mission control</em>
        </span>
      </header>
      <main className="shell" aria-busy="true">
        <p className="note">Loading the bank…</p>
      </main>
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
