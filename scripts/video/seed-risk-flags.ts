/**
 * Video prep — seed REAL Risk Desk flags in the MAIN world of a deployed
 * bank, through the public flows only (no DB access, no test shortcuts,
 * rate limits respected):
 *
 *   npx tsx --env-file=.env.local scripts/video/seed-risk-flags.ts \
 *     [--base https://mandate-bank.onrender.com] [--account CLIENT] [--headed] [--wait-min 70]
 *
 * One human (the PayPal sandbox account `PAYPAL_<account>_*`, default
 * CLIENT so the recording owner's dashboard stays clean) does what a
 * person would, in a local Playwright browser (the acceptance harness's
 * approach, `tests/helpers/*`):
 *
 * 1. Verify with PayPal (approve the $0.01 identity order, never captured)
 *    → a `mandate_session` cookie.
 * 2. Registers "Risk demo · Echo" from the dashboard (path B), signs its
 *    mandate in the drawer ($500/loan, unsecured allowed), and the agent
 *    then applies over REST four times: three large unsecured asks that a
 *    fresh grade-E agent is declined for, then a smaller one
 *    → the `probing` detector (≥ 3 declines, then a smaller ask within a
 *    sim day).
 * 3. Registers four more agents ("Risk demo · Foxtrot/Golf/Hotel/India")
 *    within the same few minutes → five agents by one human inside ten
 *    minutes → the `sybil_burst` detector (≥ 4).
 *
 * The bank's every-minute tick ships the rows to Elastic; the ES|QL
 * detectors run at most once an hour per world (`DETECTOR_INTERVAL_MS`,
 * services/riskDesk.ts), so flags can take up to ~60 minutes to appear;
 * the AI investigator then writes case files (2 per world per tick).
 * The script then polls the public console snapshot
 * (`/api/console/snapshot?world=main`) until the flags and at least one
 * case-file verdict show. The full case file is in the owner's dashboard
 * drawer (`/dashboard?agent=<id>` → Risk review → "Case file"); the console
 * Risk Desk lists each flag with its recommendation.
 *
 * Patterns that need real money (self-dealing, score farming, redemption
 * velocity: a funded loan / notes and PayPal checkouts) are not seeded.
 * Never prints secrets: API keys stay in memory, emails are not logged.
 */
import { chromium, type Page } from "@playwright/test";

import { signMandateInDrawer } from "../../tests/helpers/humanOwner";
import { approveOnPage } from "../../tests/helpers/paypalApprove";

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
}
const BASE = arg("base", "https://mandate-bank.onrender.com").replace(/\/$/, "");
const ACCOUNT = arg("account", "CLIENT").toUpperCase();
const HEADED = args.includes("--headed");
const WAIT_MIN = Number(arg("wait-min", "70"));
const SCREENS = "test-results/video-seed";

const PROBER = "Risk demo · Echo";
const SYBILS = ["Risk demo · Foxtrot", "Risk demo · Golf", "Risk demo · Hotel", "Risk demo · India"];
/** Three declined unsecured asks (a new agent is grade E), then a smaller one. */
const PROBE_AMOUNTS = [45000, 35000, 25000, 2000];

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (load .env.local with --env-file)`);
  return value;
}

function log(line: string): void {
  console.log(`[seed] ${line}`);
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${BASE}/verify?returnTo=${encodeURIComponent("/dashboard")}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByRole("button", { name: /^Verify with PayPal/ }).click();
  await page.waitForURL(/paypal\.com/, { timeout: 60_000 });
  const approval = await approveOnPage(page, {
    email: env(`PAYPAL_${ACCOUNT}_EMAIL`),
    password: env(`PAYPAL_${ACCOUNT}_PASSWORD`),
    returnUrlPrefix: `${BASE}/verify/return`,
    screenshotDir: SCREENS,
    label: "seed-verify",
  });
  if (!approval.ok) {
    throw new Error(`Verify with PayPal failed${approval.blocked ? " (PayPal challenge: stopping)" : ""}: ${approval.errorText ?? "?"}`);
  }
  await page.waitForURL((url) => url.origin === new URL(BASE).origin && !url.pathname.startsWith("/verify"), { timeout: 60_000 });
  log(`signed in as the ${ACCOUNT} sandbox account`);
}

/** Path B: register an agent in the main world; returns its id and (in memory only) its API key. */
async function registerAgent(page: Page, name: string): Promise<{ id: string; key: string }> {
  await page.goto(`${BASE}/dashboard/agents/new`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("#r-name").fill(name);
  await page.locator("#r-operator").fill("Mandate video prep");
  await page.locator("#r-model").fill("risk-demo-script");
  await page.locator("#r-payout").fill(env(`PAYPAL_${ACCOUNT}_EMAIL`));
  await page.getByRole("button", { name: "Register agent", exact: true }).click();
  await page.waitForURL(/\/dashboard\/agents\/[0-9a-f-]{36}\/api-key/, { timeout: 60_000 });
  const id = /\/dashboard\/agents\/([0-9a-f-]{36})\//.exec(page.url())![1]!;
  const key = (await page.getByTestId("api-key").textContent())?.trim() ?? "";
  if (!key.startsWith("mnd_")) throw new Error(`no API key shown for ${name}`);
  log(`registered "${name}" (${id.slice(0, 8)})`);
  return { id, key };
}

async function tool(name: string, key: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/api/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { http: res.status, ...body };
}

interface Snapshot {
  risk: {
    open: number;
    byKind: Array<{ kind: string; open: number }>;
    recent: Array<{ flag: string; kind: string; agent: string; status: string; recommendation: string | null; source: string | null }>;
  };
}

async function riskDesk(): Promise<Snapshot["risk"] | null> {
  const res = await fetch(`${BASE}/api/console/snapshot?world=main`, { headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const body = (await res.json()) as { snapshot?: Snapshot } & Partial<Snapshot>;
  return (body.snapshot ?? (body as Snapshot)).risk ?? null;
}

async function main(): Promise<void> {
  const warm = await fetch(`${BASE}/llms.txt`);
  log(`base ${BASE} → ${warm.status}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext();
  const page = await context.newPage();
  const names = [PROBER, ...SYBILS];
  try {
    await signIn(page);

    // 1. The prober: claimed at birth (path B), mandate signed, then the probe.
    const echo = await registerAgent(page, PROBER);
    const signed = await signMandateInDrawer(
      page,
      BASE,
      echo.id,
      { maxPerLoanUsd: "500", maxTotalOwedUsd: "1000", maxFeePct: "10", maxTermDays: "30", collateral: ["invoice_link", "none"] },
      "Risk Demo",
    );
    if (!signed.ok) throw new Error(`mandate not signed: ${signed.notice}`);
    log(`mandate signed for "${PROBER}" (${signed.tier ?? "?"})`);
    for (const amount of PROBE_AMOUNTS) {
      const out = await tool("apply_for_loan", echo.key, {
        amount_cents: amount,
        term_days: 30,
        purpose: "Risk demo: working capital for a client project",
      });
      const data = (out.data ?? {}) as Record<string, unknown>;
      const reasons = (out.reasons ?? data.reasons ?? []) as unknown[];
      log(`apply_for_loan ${amount} → HTTP ${String(out.http)} ${String(out.status ?? out.error ?? "")} ${JSON.stringify(reasons).slice(0, 120)}`);
      await page.waitForTimeout(1500);
    }

    // 2. The sybil burst: four more agents by the same human, minutes apart at most.
    for (const name of SYBILS) {
      await registerAgent(page, name);
    }
  } finally {
    await browser.close();
  }

  // 3. Wait for the tick: ship → ES|QL detectors → investigator.
  const deadline = Date.now() + WAIT_MIN * 60_000;
  let ours: Snapshot["risk"]["recent"] = [];
  for (;;) {
    const risk = await riskDesk();
    if (risk) {
      ours = risk.recent.filter((f) => names.includes(f.agent));
      const byKind = risk.byKind.filter((k) => k.open > 0).map((k) => `${k.kind}=${k.open}`).join(" ");
      const kinds = new Set(ours.filter((f) => f.status === "open").map((f) => f.kind));
      const cased = ours.filter((f) => f.recommendation);
      log(`risk desk: ${risk.open} open (${byKind || "none"}); ours ${ours.length}, case files ${cased.length}`);
      if (kinds.has("probing") && kinds.has("sybil_burst") && cased.length > 0) break;
    }
    if (Date.now() > deadline) {
      log("timed out waiting for flags/case files (the tick may still be catching up)");
      break;
    }
    await new Promise((r) => setTimeout(r, 20_000));
  }
  for (const f of ours) {
    log(`${f.flag} ${f.kind} · ${f.agent} · ${f.status} · case file ${f.recommendation ? `${f.recommendation} (${f.source})` : "pending"}`);
  }
}

main().catch((err: unknown) => {
  console.error(`[seed] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
