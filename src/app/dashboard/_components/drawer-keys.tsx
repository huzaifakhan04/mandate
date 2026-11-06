"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * The drawer's only client JS: focus moves into the drawer when it opens
 * (without scrolling), and Escape closes it. Without JS the drawer is
 * still a plain URL state (`/dashboard?agent=<id>`) with a Close link.
 */
export function DrawerKeys({ closeHref }: { closeHref: string }) {
  const router = useRouter();

  useEffect(() => {
    const drawer = document.getElementById("agent-drawer");
    if (drawer && !drawer.contains(document.activeElement)) {
      drawer.focus({ preventScroll: true });
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
