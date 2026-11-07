"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * The drawer's only client JS: focus moves into the drawer when it opens
 * (scrolling it into view only where it stacks below the page), and Escape closes it. Without JS the drawer is
 * still a plain URL state (`/dashboard?agent=<id>`) with a Close link.
 */
export function DrawerKeys({ closeHref }: { closeHref: string }) {
  const router = useRouter();

  useEffect(() => {
    const drawer = document.getElementById("agent-drawer");
    if (drawer && !drawer.contains(document.activeElement)) {
      // Below 1100px the drawer stacks under the page instead of sliding in,
      // so bring it into view; on desktop it is fixed and needs no scroll.
      const stacked = window.matchMedia("(max-width: 1100px)").matches;
      drawer.focus({ preventScroll: true });
      if (stacked) {
        // Land the drawer heading just below the sticky top bar, not under it.
        const bar = document.querySelector<HTMLElement>(".shell-side");
        const barIsSticky = bar && window.getComputedStyle(bar).position === "sticky";
        const offset = (barIsSticky ? bar.offsetHeight : 0) + 8;
        window.scrollTo({ top: drawer.getBoundingClientRect().top + window.scrollY - offset });
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      router.push(closeHref, { scroll: false });
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeHref, router]);

  return null;
}
