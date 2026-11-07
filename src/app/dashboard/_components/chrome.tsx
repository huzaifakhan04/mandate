import Link from "next/link";

import { MandateLogo } from "@/components/brand/MandateLogo";
import { IconAgent, IconBell, IconGlobe, IconLogout, IconTimeline } from "@/components/ui/icons";
import { LEGAL } from "@/components/ui/legal";
import { getDb } from "@/server/db/client";
import { maskPayoutEmail } from "@/server/services/agents";
import { ownerNotices } from "@/server/services/dashboard";
import { getPrincipal } from "@/server/services/principals";
import { listPrivateWorlds } from "@/server/services/privateWorlds";

import { formatDate, initials } from "./format";

/** One source of truth for the legal line (re-exported for the owner pages). */
export { LEGAL };

export type Tone = "ok" | "warn" | "risk" | "dark" | "blue" | "plain";

const TONE_CLASS: Record<Tone, string> = {
  ok: "ok",
  warn: "warn",
  risk: "risk",
  dark: "risk",
  blue: "accent",
  plain: "",
};

/** A status: a small dot plus a plain label (`.ui-st`), never a filled pill. */
export function Pill({ tone, children, label }: { tone: Tone; children: React.ReactNode; label?: string }) {
  const cls = TONE_CLASS[tone];
  return (
    <span className={`ui-st${cls ? ` ${cls}` : ""}`} aria-label={label}>
      {children}
    </span>
  );
}

export type OwnerNav = "agents" | "timeline" | "worlds" | "notices" | "none";

/**
 * The owner pages' shell (the shared `.shell` from globals.css): the
 * sidebar (brand, world switcher — a plain GET form, works without JS —
 * owner nav, the signed-in principal and Log out) and the header (crumb,
 * the world clock of a private world, the notices bell).
 *
 * `clock="controls"` (the world page) puts the clock's +1 / +7 / Reset
 * forms in the header; `"compact"` (the default) shows the selected
 * private world's name, date and +1 / +7.
 */
export async function OwnerShell({
  principalId,
  worldId,
  current = "agents",
  crumb,
  clock = "compact",
  agentCount,
  hasDrawer = false,
  drawer,
  children,
}: {
  principalId: string;
  /** The selected private world, if any (the main world otherwise). */
  worldId?: string;
  current?: OwnerNav;
  crumb: React.ReactNode;
  clock?: "controls" | "compact";
  agentCount?: number;
  hasDrawer?: boolean;
  drawer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const db = await getDb();
  const principal = await getPrincipal(db, principalId);
  const privateWorlds = await listPrivateWorlds(db, principalId);
  const world = privateWorlds.find((w) => w.id === worldId);
  const selected = world?.id ?? "";
  const name = principal?.name ?? "Signed in";
  // P4 Task 4: the owner's unread notices in this view (bell → the notices panel).
  const { unread } = await ownerNotices(db, principalId, { worldId: selected || undefined, limit: 0 });
  const worldQuery = selected ? `?world=${selected}` : "";
  const timelineHref = `/dashboard?${new URLSearchParams({ ...(selected ? { world: selected } : {}), view: "timeline" }).toString()}`;
  const unreadText = unread > 99 ? "99+" : String(unread);

  return (
    <div className={`shell owner${hasDrawer ? " has-drawer" : ""}`}>
      <aside className="shell-side" aria-label="Owner">
        <Link className="shell-brand" href="/dashboard" aria-label="Mandate home">
          <MandateLogo size={16} />
        </Link>
        <div className="shell-world">
          {privateWorlds.length > 0 ? (
            <form className="worldswitch" method="get" action="/dashboard" data-testid="world-switcher">
              <label className="sr-only" htmlFor="world-select">
                World
              </label>
              <select id="world-select" name="world" defaultValue={selected}>
                <option value="">Main world</option>
                {privateWorlds.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} · sandbox
                  </option>
                ))}
              </select>
              <button type="submit" className="ui-btn">
                Go
              </button>
            </form>
          ) : (
            <span className="world-static">
              Main world <span className="ui-tag">PayPal sandbox</span>
            </span>
          )}
        </div>
        <nav className="shell-nav" aria-label="Dashboard">
          <Link
            href={`/dashboard${worldQuery}`}
            aria-current={current === "agents" ? "page" : undefined}
            data-testid="view-agents"
          >
            <IconAgent size={16} />
            Agents
            {agentCount !== undefined ? <span className="count">{agentCount}</span> : null}
          </Link>
          <Link
            href={timelineHref}
            aria-current={current === "timeline" ? "page" : undefined}
            data-testid="view-timeline"
          >
            <IconTimeline size={16} />
            Timeline
          </Link>
          <Link href="/dashboard/worlds" aria-current={current === "worlds" ? "page" : undefined}>
            <IconGlobe size={16} />
            Worlds
            {privateWorlds.length > 0 ? <span className="count">{privateWorlds.length}</span> : null}
          </Link>
          <Link href={`/dashboard${worldQuery}#notices`} aria-current={current === "notices" ? "page" : undefined}>
            <IconBell size={16} />
            Notices
            {unread > 0 ? <span className="count warn">{unreadText}</span> : null}
          </Link>
        </nav>
        <div className="shell-foot">
          <div className="who">
            <span className="av" aria-hidden="true">
              {initials(name)}
            </span>
            <span className="id">
              <b data-testid="principal-name">{name}</b>
              <small data-testid="principal-email">
                {principal ? maskPayoutEmail(principal.email) : ""} · via PayPal · sandbox
              </small>
            </span>
            <form method="post" action="/logout">
              <button type="submit" className="ui-btn ghost logout">
                <IconLogout size={14} />
                Log out
              </button>
            </form>
          </div>
        </div>
      </aside>
      <div className="shell-main">
        <header className="shell-head">
          <div className="crumb">{crumb}</div>
          {world ? (
            <div className="wclock" data-testid={clock === "controls" ? "clock-controls" : undefined}>
              {clock === "compact" ? (
                <Link className="wname" href={`/dashboard/worlds/${world.id}`} data-testid="world-name">
                  {world.name}
                </Link>
              ) : (
                <b className="wname" data-testid="world-name">
                  {world.name}
                </b>
              )}
              <span className="wdate num" data-testid="sim-date">
                Day {world.simDay} · {formatDate(world.simNow)}
              </span>
              <form method="post" action={`/dashboard/worlds/${world.id}/advance`}>
                <input type="hidden" name="days" value="1" />
                <button type="submit" className="ui-btn" data-testid="advance-1">
                  +1 day
                </button>
              </form>
              <form method="post" action={`/dashboard/worlds/${world.id}/advance`}>
                <input type="hidden" name="days" value="7" />
                <button type="submit" className="ui-btn" data-testid="advance-7">
                  +7 days
                </button>
              </form>
              {clock === "controls" ? (
                <form method="post" action={`/dashboard/worlds/${world.id}/reset`}>
                  <button type="submit" className="ui-btn ghost">
                    Reset
                  </button>
                </form>
              ) : null}
            </div>
          ) : (
            <span className="ui-st in rail">PayPal rail · sandbox</span>
          )}
          <span className="grow" />
          <Link
            className="bell"
            href={`/dashboard${worldQuery}#notices`}
            data-testid="notices-badge"
            aria-label={unread > 0 ? `Notices: ${unread} unread` : "Notices: none unread"}
          >
            <IconBell size={16} />
            {unread > 0 ? (
              <span className="count num" aria-hidden="true">
                {unreadText}
              </span>
            ) : null}
          </Link>
        </header>
        <main className="shell-body" id="main">
          {children}
        </main>
        {drawer}
      </div>
    </div>
  );
}

/** Crumb segments separated by a drawn chevron; the last one is the current page. */
export function Crumb({ items }: { items: Array<{ label: React.ReactNode; href?: string }> }) {
  return (
    <>
      {items.map((item, i) => (
        <span key={i} className="crumb-i">
          {i > 0 ? (
            <svg
              className="sep"
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6.5 4.5L10 8l-3.5 3.5" />
            </svg>
          ) : null}
          {item.href ? <Link href={item.href}>{item.label}</Link> : <b>{item.label}</b>}
        </span>
      ))}
    </>
  );
}

/** The Suspense fallback: the shell's frame without data. */
export function LoadingFrame() {
  return (
    <div className="shell owner">
      <aside className="shell-side" aria-label="Owner">
        <span className="shell-brand">
          <MandateLogo size={16} />
        </span>
      </aside>
      <div className="shell-main">
        <header className="shell-head">
          <div className="crumb" />
        </header>
        <main className="shell-body" aria-busy="true">
          <p className="sub">Loading…</p>
        </main>
      </div>
    </div>
  );
}
