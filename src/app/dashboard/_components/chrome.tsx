import Link from "next/link";

import { getDb } from "@/server/db/client";
import { maskPayoutEmail } from "@/server/services/agents";
import { listOwnedPrivateWorlds } from "@/server/services/privateWorldAccess";
import { getPrincipal } from "@/server/services/principals";

import { initials } from "./format";

export const LEGAL = "Sandbox model · simulated money · notes are not deposits and not FDIC-insured";

export type Tone = "ok" | "warn" | "risk" | "blue" | "plain";

export function Pill({ tone, children, label }: { tone: Tone; children: React.ReactNode; label?: string }) {
  return (
    <span className={`pill ${tone}`} aria-label={label}>
      {children}
    </span>
  );
}

/**
 * The top bar: brand, nav, the world switcher (P2 Task 6: main or one of
 * the principal's private sandbox worlds — a plain GET form, works
 * without JS), the signed-in principal (email masked) and Log out.
 */
export async function TopBar({
  principalId,
  worldId,
  current = "agents",
}: {
  principalId: string;
  /** The selected private world, if any (the main world otherwise). */
  worldId?: string;
  current?: "agents" | "worlds";
}) {
  const db = await getDb();
  const principal = await getPrincipal(db, principalId);
  const privateWorlds = await listOwnedPrivateWorlds(db, principalId);
  const selected = privateWorlds.some((world) => world.id === worldId) ? worldId : "";
  const name = principal?.name ?? "Signed in";
  return (
    <header className="top">
      <Link className="brand" href="/dashboard" aria-label="Mandate — your agents">
        <i aria-hidden="true">M</i>Mandate
      </Link>
      <nav className="nav" aria-label="Dashboard">
        <Link href={selected ? `/dashboard?world=${selected}` : "/dashboard"} aria-current={current === "agents" ? "page" : undefined}>
          Agents
        </Link>
        <Link href="/dashboard/worlds" aria-current={current === "worlds" ? "page" : undefined}>
          Sandbox worlds
        </Link>
      </nav>
      {privateWorlds.length > 0 ? (
        <form className="worldswitch" method="get" action="/dashboard" data-testid="world-switcher">
          <label className="sr-only" htmlFor="world-select">
            World
          </label>
          <select id="world-select" name="world" className="input" defaultValue={selected}>
            <option value="">Main world</option>
            {privateWorlds.map((world) => (
              <option key={world.id} value={world.id}>
                {world.name} · sandbox
              </option>
            ))}
          </select>
          <button type="submit" className="btn sm">
            Go
          </button>
        </form>
      ) : null}
      <div className="who">
        <div className="id">
          <b data-testid="principal-name">{name}</b>
          <small data-testid="principal-email">
            {principal ? maskPayoutEmail(principal.email) : ""} · via PayPal · sandbox
          </small>
        </div>
        <span className="av" aria-hidden="true">
          {initials(name)}
        </span>
        <form method="post" action="/logout">
          <button type="submit" className="logout">
            Log out
          </button>
        </form>
      </div>
    </header>
  );
}

/** The `.dash` frame every dashboard page renders inside. */
export function DashFrame({ children, hasDrawer = false }: { children: React.ReactNode; hasDrawer?: boolean }) {
  return <div className={`dash${hasDrawer ? " has-drawer" : ""}`}>{children}</div>;
}

export function LoadingFrame() {
  return (
    <DashFrame>
      <header className="top">
        <span className="brand">
          <i aria-hidden="true">M</i>Mandate
        </span>
      </header>
      <main className="page" aria-busy="true">
        <p className="sub">Loading…</p>
      </main>
    </DashFrame>
  );
}
