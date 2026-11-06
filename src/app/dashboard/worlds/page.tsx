import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { requirePagePrincipal } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { MAX_PRIVATE_WORLDS, listPrivateWorlds } from "@/server/services/privateWorlds";

import { DashFrame, LEGAL, LoadingFrame, TopBar } from "../_components/chrome";
import { formatDate } from "../_components/format";
import "../dashboard.css";

export const metadata: Metadata = {
  title: "Mandate · Sandbox worlds",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const ERRORS: Record<string, string> = {
  limit: `You already have ${MAX_PRIVATE_WORLDS} sandbox worlds. Reset one to start it over.`,
  invalid: "Give the world a name (1–60 characters).",
  error: "Something went wrong. Please try again.",
};

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `/dashboard/worlds` — P2 Task 6: the principal's private sandbox worlds
 * (up to 3). Each runs on the sim rail with seeded lender and borrower
 * bots and a clock the owner moves — a living bank without spending
 * sandbox PayPal.
 */
async function Worlds({ searchParams }: { searchParams: SearchParams }) {
  const session = await requirePagePrincipal("/dashboard/worlds");
  const params = await searchParams;
  const worlds = await listPrivateWorlds(await getDb(), session.principalId);
  const error = ERRORS[one(params.error) ?? ""];
  const full = worlds.length >= MAX_PRIVATE_WORLDS;

  return (
    <DashFrame>
      <TopBar principalId={session.principalId} current="worlds" />
      <main className="page">
        <div className="narrow">
          <Link className="crumb" href="/dashboard">
            ← Your agents
          </Link>
          <div className="head">
            <div>
              <h1>Sandbox worlds</h1>
              <p className="sub">
                A private bank of your own: simulated money only, never PayPal. Two lender bots fund the pool and two
                borrower bots take invoice-backed loans as you move the clock.
              </p>
            </div>
          </div>
          {error ? (
            <div className="notice err" role="alert">
              {error}
            </div>
          ) : null}

          <section className="panel" aria-labelledby="worlds-h">
            <h2 id="worlds-h">
              Your worlds ({worlds.length} of {MAX_PRIVATE_WORLDS})
            </h2>
            {worlds.length === 0 ? (
              <p>No sandbox worlds yet. Create one below.</p>
            ) : (
              <ul className="worldlist" data-testid="world-list">
                {worlds.map((world) => (
                  <li key={world.id}>
                    <div>
                      <b>{world.name}</b>
                      <small>
                        Simulated day {world.simDay} · {formatDate(world.simNow)}
                      </small>
                    </div>
                    <Link className="btn sm" href={`/dashboard/worlds/${world.id}`}>
                      Open
                    </Link>
                    <Link className="btn sm" href={`/dashboard?world=${world.id}`}>
                      My agents here
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel" aria-labelledby="create-h">
            <h2 id="create-h">Create a world</h2>
            <p>Seeding takes a few seconds: the lender bots buy $200 and $150 of notes.</p>
            <form method="post" action="/dashboard/worlds/create" style={{ display: "grid", gap: 12 }}>
              <div className="field">
                <label htmlFor="w-name">World name</label>
                <input
                  className="input"
                  id="w-name"
                  name="name"
                  required
                  maxLength={60}
                  placeholder="Demo bank"
                  disabled={full}
                  aria-describedby="hint-w-name"
                />
                <span className="hint" id="hint-w-name">
                  {full ? "You have the maximum of three; reset one to start over." : "Just for you; nobody else can see it."}
                </span>
              </div>
              <button type="submit" className="btn primary block" disabled={full}>
                Create world
              </button>
            </form>
          </section>
          <p className="pagelegal">{LEGAL}</p>
        </div>
      </main>
    </DashFrame>
  );
}

export default function WorldsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<LoadingFrame />}>
      <Worlds searchParams={searchParams} />
    </Suspense>
  );
}
