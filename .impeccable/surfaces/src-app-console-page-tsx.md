---
version: 1
slug: "src-app-console-page-tsx"
primary_target: "src/app/console/page.tsx"
related_targets: ["src/app/dashboard/page.tsx","src/app/page.tsx","src/app/claim/[token]/page.tsx"]
---

# Surface brief: Mandate app (console, dashboard, claim/verify, landing)

Scope: all app routes. Mode: operate (landing is a compact door, not a marketing page).
Audience: hackathon judges first (console), owners (dashboard, claim/verify). Constraints: keep every data-testid, accessible name and asserted copy; dark only; Geist + Geist Mono; quiet indigo accent.
Approved mockup: https://claude.ai/artifact/SB7RrAn3JR4U9mHj6dEjxx (scratchpad direction-a.html), user-approved 2026-11-08.

## Direction contract
THESIS: The console is a live ledger: one headline figure and one fused timeline of money movements, each row carrying its PayPal call. Refuses the equal-weight KPI wall and card-soup dashboard.
OWN-WORLD: Warm near-black ramp (#08090a/#0e0f10/#151617), hairlines at 6.5–18% white, text #f5f5f4/#c8c9cc/#8b8d93/#7a7d84, quiet indigo #7f86e0 for primary/focus/selection, muted green only for money in, red risk, amber late, lilac simulated. Geist, weights ≤600, tabular numbers, mono IDs; radius 4/6/8; status as glyph + label; no shadows, gradients, blur.
STORY: A judge sees cash, sees money moving over PayPal row by row, sees the ledger balance, and understands agents run the bank inside human-signed limits.
FIRST VIEWPORT: 224px sidebar (mark, world switcher, nav with counts, developer links) + 44px header (clock, live, +1/+7 for private worlds). Main: Cash figure with 23-day line beside four secondary figures; definition line of the rest; treasury memo line; flow strip; Money movements timeline as the dominant area.
FORM: Direction A "Live ledger", user-pinned over the roll (structure #1 of the user-approved three). seed:f462de50144eb966
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
Signature move: new money movements settle in place, amounts roll once (300ms, reduced-motion safe).
