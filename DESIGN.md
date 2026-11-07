---
name: Mandate
description: The bank for AI agents, shown as a live ledger on a warm near-black ground.
colors:
  bg: "#08090a"
  panel: "#0e0f10"
  raised: "#151617"
  hover: "#1b1c1e"
  press: "#222326"
  line: "rgba(255, 255, 255, 0.065)"
  line-2: "rgba(255, 255, 255, 0.11)"
  line-3: "rgba(255, 255, 255, 0.18)"
  t1: "#f5f5f4"
  t2: "#c8c9cc"
  t3: "#8b8d93"
  t4: "#7a7d84"
  acc: "#7f86e0"
  acc-fill: "#5b62c9"
  acc-fill-hover: "#4f56bd"
  acc-ink: "#ffffff"
  acc-soft: "rgba(127, 134, 224, 0.14)"
  focus: "rgba(127, 134, 224, 0.6)"
  in: "#5cb88a"
  in-soft: "rgba(92, 184, 138, 0.12)"
  risk-c: "#e5675e"
  risk-c-soft: "rgba(229, 103, 94, 0.12)"
  warn: "#d6a24a"
  warn-soft: "rgba(214, 162, 74, 0.12)"
  sim: "#a59bd9"
  sim-soft: "rgba(165, 155, 217, 0.1)"
typography:
  display:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "36px"
    fontWeight: 560
    lineHeight: 1.12
    letterSpacing: "-0.025em"
  figure:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "34px"
    fontWeight: 500
    lineHeight: 1.05
    letterSpacing: "-0.025em"
    fontFeature: "tnum"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 560
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  section:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 560
    lineHeight: 1.3
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "-0.003em"
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  mono:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: "tnum"
rounded:
  r1: "4px"
  r2: "6px"
  r3: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
  3xl: "32px"
components:
  button:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.t1}"
    rounded: "{rounded.r2}"
    padding: "0 10px"
    height: "28px"
  button-hover:
    backgroundColor: "{colors.hover}"
  button-primary:
    backgroundColor: "{colors.acc-fill}"
    textColor: "{colors.acc-ink}"
    rounded: "{rounded.r2}"
    padding: "0 10px"
    height: "28px"
  button-primary-hover:
    backgroundColor: "{colors.acc-fill-hover}"
  button-primary-lg:
    backgroundColor: "{colors.acc-fill}"
    textColor: "{colors.acc-ink}"
    rounded: "{rounded.r2}"
    padding: "0 14px"
    height: "34px"
  button-ghost:
    textColor: "{colors.t2}"
    rounded: "{rounded.r2}"
    padding: "0 10px"
    height: "28px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.t1}"
    rounded: "{rounded.r2}"
    padding: "0 10px"
    height: "30px"
  tag:
    textColor: "{colors.t2}"
    rounded: "{rounded.r1}"
    padding: "0 6px"
    height: "18px"
  tag-sim:
    backgroundColor: "{colors.sim-soft}"
    textColor: "{colors.sim}"
    rounded: "{rounded.r1}"
    padding: "0 6px"
    height: "18px"
  kbd:
    textColor: "{colors.t3}"
    rounded: "{rounded.r1}"
    padding: "0 4px"
    height: "18px"
  nav-item:
    textColor: "{colors.t2}"
    rounded: "{rounded.r2}"
    padding: "0 8px"
    height: "30px"
  nav-item-active:
    backgroundColor: "{colors.press}"
    textColor: "{colors.t1}"
  sidebar:
    backgroundColor: "{colors.panel}"
    width: "224px"
  header:
    backgroundColor: "{colors.bg}"
    height: "44px"
---

# Design System: Mandate

## Overview

**Creative North Star: "The Live Ledger"**

Mandate reads like a ledger that is running while you watch. One headline figure, then a fused timeline of money movements, each row carrying the PayPal call behind it. Everything else steps back: a warm near-black ground, hairlines instead of boxes, small dense type, and colour held in reserve for meaning. The app is dark only (`color-scheme: dark`); there is no light theme.

Density is deliberate and operator-grade: 13px body, 28 to 38px rows, 12px labels. Structure comes from spacing and 1px white-alpha hairlines; there are no cards, no shadows, no gradients, no blur. The one motion that matters is the signature move: a new money movement settles into place once, then the ledger is still again.

The build diverges from its direction contract in one place: the contract named `#5f6268` for the faintest text, which measured about 3.3:1 on the ground. The shipped `--t4` is `#7a7d84` (about 4.8:1). The build wins.

**Key Characteristics:**
- Dark only, warm near-black surface ramp in five steps.
- Hairline structure at 6.5, 11 and 18% white; no cards, no elevation.
- One quiet indigo for action, focus and selection; status colours only for meaning, always beside a word.
- Geist and Geist Mono, weights 400, 500 and 560, never above 600; tabular numbers on every figure.
- Radius 4, 6, 8 and nothing larger inside the app.
- Signature move: new movement rows settle in place (300ms, reduced-motion safe).

## Colors

A graphite ground with one muted indigo voice and four status hues that speak only when something happened.

### Primary
- **Quiet Indigo** (`acc`): the line-weight indigo for focus borders on inputs, the caret, checkbox and radio accents, progress fills, the `.ui-st.accent` dot, and AG Grid / Bryntum accents. Used as a stroke or small mark, never as the fill under white text (white on it is only about 3.3:1).
- **Deep Indigo Fill** (`acc-fill`, hover `acc-fill-hover`): the filled primary. It exists because `acc` cannot carry white text; `acc-fill` with `acc-ink` white clears about 5.2:1. Used for `.ui-btn.primary` and Bryntum's "today" day number, and nothing else.
- **Indigo Wash** (`acc-soft`): text selection and AG Grid selected rows. **Focus Ring** (`focus`): the 2px `:focus-visible` outline everywhere.

### Status (meaning only)
- **Money-In Green** (`in`, `in-soft`): money that came into the bank, completed checks, the live dot. Money out stays neutral (`t1`/`t2`), never red.
- **Risk Red** (`risk-c`, `risk-c-soft`): failed calls, invalid fields, risk counts, danger buttons.
- **Late Amber** (`warn`, `warn-soft`): late payments, unread counts, the simulated-time "now" line.
- **Simulated Lilac** (`sim`, `sim-soft`): marks simulated money and demo worlds (`.ui-tag.sim`).

### Neutral
- **Ground** (`bg`): page and header background, AG Grid body.
- **Panel** (`panel`): sidebar, drawer, input fill, row hover, grid headers, Bryntum panels.
- **Raised** (`raised`): default button, select, popups, menus, tooltips, code blocks, selected agent row.
- **Hover** (`hover`) and **Press** (`press`): interaction steps; `press` is also the active nav item and pressed segment.
- **Hairlines** (`line`, `line-2`, `line-3`): `line` separates rows and regions; `line-2` borders controls; `line-3` is the hover border and the flow-strip connectors.
- **Text ramp** (`t1` primary, `t2` secondary, `t3` labels and metadata, `t4` faintest: hints, placeholders, counts, the legal line).

### Legacy aliases
Older selectors still read the pre-redesign names; `:root` remaps them onto the dark ramp so nothing renders light: `--background`→`bg`, `--surface`→`raised`, `--ink`/`--foreground`→`t1`, `--accent`→`acc`, `--money-in*`→`in`, `--risk*`→`risk-c`, `--amber*`→`warn`, `--muted`→`t2`, `--faint`→`t3`, `--radius`→`r3`, `--shadow: none`. Tailwind's `@theme inline` exposes the same tokens as `bg-background`, `text-t1`…`text-t4`, `border-line`, `text-money-in`, `text-risk`, `text-warn`, `text-sim`. New code uses the short names.

### Named Rules
**The Meaning-Only Rule.** Green, red, amber and lilac appear only when they mean money in, risk, late or simulated, and always next to a word that says the same thing. Decoration never gets a status hue.

**The Two Indigos Rule.** `acc` draws lines and marks; `acc-fill` carries white text. Never put white text on `acc`.

**The Faint Floor Rule.** `t4` clears about 4.8:1 on `bg` and about 4.65:1 on `panel`, but only about 4.4:1 on `raised`. Put `t4` text on `bg` or `panel` only; on `raised` and above, step up to `t3`.

## Typography

**Display / Body Font:** Geist (via `--font-geist-sans`, falling back to ui-sans-serif, system-ui)
**Mono Font:** Geist Mono (via `--font-geist-mono`, falling back to ui-monospace, SFMono-Regular, Menlo)

**Character:** One neutral grotesque at small sizes with slightly tightened tracking, and its mono twin for anything a machine produced: IDs, timestamps, account names, PayPal operation names.

### Hierarchy
- **Display** (560, 28px mobile / 36px desktop, 1.12, -0.025em): the landing headline only.
- **Figure** (500, 34px, 30px under 720px, 1.05, -0.025em): the single headline Cash figure on the console. Secondary figures step down to 17px/500, flow nodes 14 to 15px/500, dashboard summaries 15px/500.
- **Title** (560, 17 to 20px, -0.01 to -0.015em): page h1 (18px), drawer heading (17px), auth heading (20px).
- **Section** (560, 13 to 15px): section heads; console movements head 15px, dashboard sections 14px, drawer sections and sub-heads 13px.
- **Body** (400, 13px, 1.45, -0.003em): default for rows, nav, inputs. Dense secondary copy runs 12.5px.
- **Label** (400, 11.5 to 12.5px, colour `t3` or `t4`): column headers, field labels, hints, legal. Sentence case; no uppercase, no letterspaced eyebrows.
- **Mono** (400, 11.5 to 12px): times, journal IDs, PayPal operations, account codes, snippets.

### Named Rules
**The 560 Ceiling Rule.** The weights are 400, 500 and 560. Nothing ships above 600; emphasis comes from colour step (`t3`→`t1`) before weight.

**The Tabular Rule.** Every number that can change or be compared uses `font-variant-numeric: tabular-nums` (`.num`, grid money columns, counts, `dd` values, the affix input) and is right-aligned in columns.

## Layout

The app is an inverted-L shell: a 224px sticky sidebar on `panel` with a 1px right hairline, and a 44px sticky header on `bg` with a bottom hairline. Body padding is 20px 24px 40px. The landing is a single 720px column; auth pages are a centred 400px column.

Spacing runs on a 4px base, mostly 4 / 6 / 8 / 10 / 12 / 16 / 20 / 24 / 32. Rows are measured, not padded: header rows 30px, movement rows 38px minimum, agent rows 48px minimum, grid rows 34px with 32px headers. Lists are CSS grids with fixed numeric columns and a flexible text column.

Responsive behaviour: under 1280px the console KPI row stacks; under 1100px the flow strip turns vertical and the dashboard drawer (480px, fixed right) becomes an in-flow section; under 900px the shell collapses; under 720px movement rows reflow into a two-line grid and the four secondary figures go two by two. The agent list uses container queries (720px, 500px) rather than viewport breakpoints.

### Named Rules
**The Shell Collapse Rule.** Below 900px the sidebar becomes a top bar: one column, the nav wraps into a horizontal row (28px items), section labels and the sidebar footer hide, the header loses its sticky position and wraps, and body padding drops to 16px 12px 32px.

## Elevation & Depth

Flat. There are no elevation shadows, no gradients, and no backdrop blur anywhere in the app, including the third-party widgets (Bryntum's `--b-elevation-1/2` are set to `none`; `--shadow` is `none`). Depth is tonal: `bg` → `panel` → `raised` → `hover` → `press`, with hairlines marking edges. The drawer is distinguished by `panel` fill and a left hairline, not a shadow. The single `box-shadow` in the system is an inset 1.5px ring that draws the hollow `.ui-st.ring` status dot; it is a stroke, not elevation.

### Named Rules
**The Hairline-Not-Shadow Rule.** If something needs separating, use a 1px `line` and spacing. If it needs to feel on top, step the surface one tone up.

## Shapes

Small, consistent corners: 4px (`r1`) for tags, kbd, tiny chips and Bryntum bands; 6px (`r2`) for buttons, inputs, nav items, selects, code blocks and the AG Grid wrapper; 8px (`r3`) for larger hosts (Bryntum, timeline placeholder). Status glyphs and avatars are full circles (7px dots, 20px movement glyph rings, 22px avatars). The only larger radius is the 14px (on 64) app-icon tile of the logo.

### Logo
The Mandate mark is four rounded bars (rx 3 on a 64 grid) forming a climbing M. Inside the app it is always **flat**: bars in `currentColor` next to the "Mandate" wordmark in Geist 560, -0.015em. The **tile** variant (solid `#151617` square, `#f5f5f4` bars) is only for favicons, app icons and OG images. No gradient, no outline, no glow.

### Icons
A drawn set in `src/components/ui/icons.tsx`: 16px viewBox, 1.5px stroke, round caps and joins, `currentColor`, rendered at 14px by default, decorative unless labelled. Direction is drawn (`IconIn`, `IconOut` diagonals), never typed as unicode arrows or emoji.

## Components

### Buttons
Compact and quiet; most actions are the neutral button.
- **Shape:** 6px radius, 28px tall (34px `.lg`), 10px side padding (14px `.lg`), Geist 500 at 12.5px (13px `.lg`), 6px icon gap.
- **Default:** `raised` fill, `line-2` border, `t1` text; hover steps to `hover` fill and `line-3` border over 150ms.
- **Primary:** `acc-fill` with white text, no border; hover `acc-fill-hover`. One per view.
- **Ghost:** transparent, `t2` text; hover gains `hover` fill and `t1`.
- **Danger:** default button with `risk-c` text, not a red fill.
- **Disabled:** 45% opacity, not-allowed cursor.

### Status (`.ui-st`)
A 7px dot plus a plain 12px `t2` label, never a filled pill. Dot variants: `ok`/`in` green, `risk` red, `warn` amber, `sim` lilac, `accent` indigo, `ring` hollow, default `t4`. Notices reuse the same grammar: a dot, a sentence, hairlines above and below.

### Tags and Kbd
- **Tag:** 18px, 4px radius, 6% white fill, `t2` text, 11px/500. `.sim` swaps to `sim-soft` and `sim`.
- **Kbd:** 18px square minimum, 4px radius, `line-2` border, `t3` text, 10.5px/500.

### Inputs / Fields
- **Style:** 30px tall, 6px radius, `panel` fill (`bg` inside the drawer), `line-2` border, 13px text, `t4` placeholder.
- **Focus:** border shifts to `acc`; no glow. Affix fields (`$`, `%`) do the same via `:focus-within`.
- **Error:** `aria-invalid` turns the border `risk-c`, with a 12px `risk-c` message below.

### Legal line (`.ui-legal`)
11.5px `t4`, one source string (`LEGAL`). Every surface carries it at the foot.

### Navigation
Sidebar items are 30px rows, 6px radius, `t2` text with `t3` icons and a right-aligned tabular `t4` count. Hover: `hover` fill, `t1`. Current page (`aria-current`): `press` fill, `t1`. Tabs are text with a 1px `t1` underline when selected; segmented controls are 22px buttons in a `line-2` outline with `press` for the pressed state.

### Ledger rows
Lists and tables are hairline rows, not cards: 30px `t3` header row, rows divided by `line`, hover `panel`. Amounts right-aligned, 500 weight, `t1`; money in is `in`; no-money rows `t4`.

### Money movement row (signature)
A six-column grid: mono time, a 20px circular direction glyph (green for in, `t2` for out), event, counterparty, mono PayPal call, amount. **Signature move:** a row that arrives with a poll gets a `hover` background and its amount fades up from 70% below inside its clipped cell (300ms, `cubic-bezier(0.2, 0, 0, 1)`), so nothing shifts. After 1.2s the class clears and the background fades back over 1.2s. Under reduced motion the amount does not animate and the row does not transition.

### Third-party widgets
- **AG Grid** (Quartz, dark scheme): params mirror the tokens as literals (JS cannot read CSS vars there): accent `#7f86e0`, ground `#08090a`, text `#c8c9cc`, header `#0e0f10` / `#8b8d93` at 12px/500, borders 6.5% white, hover `#151617`, selection indigo wash, 34px rows, radius 6/4, no column borders, no zebra. Status cells render `.ui-st`.
- **Bryntum** (Scheduler / Calendar, Svalbard dark): `src/app/_bryntum/theme.css` remaps the neutral ramp onto `panel`…`press`, sets primary to `acc`, Geist, radius `r2`/`r3`, elevations to `none`. Loan bands are flat 86%-transparent tints of their state hue; installment states prefix a word ("paid ·", "failed ·", "missed ·") so colour is never the only cue. The "now" line is `warn`; today is `acc-fill` with white.

## Do's and Don'ts

### Do:
- **Do** use the short tokens (`--bg`, `--t1`…`--t4`, `--acc`, `--in`…); treat the legacy aliases as compatibility only.
- **Do** separate with 1px `line` hairlines and spacing; step a surface tone up when something must sit on top.
- **Do** pair every status colour with a word, using the `.ui-st` dot-and-label grammar.
- **Do** set every comparable number in tabular figures, right-aligned, and every machine identifier in Geist Mono.
- **Do** use `acc-fill` (white text, about 5.2:1) for filled primary actions and `acc` for focus borders, carets and marks.
- **Do** draw icons from the 16px, 1.5px-stroke set and keep the logo flat in `currentColor` inside the app.
- **Do** keep the signature settle to one 300ms move per arriving row, and honour reduced motion.

### Don't:
- **Don't** add box-shadows for elevation, gradients, or backdrop blur, including inside AG Grid and Bryntum.
- **Don't** colour money out red or use a status hue for decoration.
- **Don't** put white text on `acc`, or `t4` text on `raised` or lighter.
- **Don't** set type above weight 600, or use uppercase letterspaced labels.
- **Don't** use filled status pills, cards around list content, or radii above 8px inside the app.
- **Don't** use unicode glyphs (✓ ✕ →) or emoji as icons.
- **Don't** use the logo tile variant inside the app.
