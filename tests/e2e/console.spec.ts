import { join } from "path";

import { expect, test, type Page } from "@playwright/test";

/**
 * P6: the public bank console (mission control) at 1280 and 390 px.
 *
 * - Anonymous (P8): the public demo world by default (badge, note, bots'
 *   activity, no clock buttons), and a switcher to the main world (real
 *   PayPal sandbox), both read-only; legal footer; snapshot API no-store
 *   and PII-free.
 * - Owner: a private world seeded with bot activity (+7 days from the
 *   console's own clock controls) — KPIs, money flow, PayPal log and the
 *   AG Grid tabs fill in; another page's clock move reaches this page by
 *   polling in under 3 s.
 * - Someone else (no session) gets 404 for that world, page and API.
 * - No page-level horizontal scroll; screenshots p6-console-{width}.png.
 */

const SCREENSHOTS = join(process.cwd(), "docs", "design", "screenshots");
const LEGAL = "Sandbox model · simulated money · notes are not deposits and not FDIC-insured";

async function signIn(page: Page, name: string) {
  const response = await page.request.post("/api/test/session", { form: { name, return_to: "/dashboard" }, maxRedirects: 0 });
  expect(response.status()).toBe(303);
}

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

for (const width of [1280, 390]) {
  test(`P6+P8: console — demo world default, main world, owner's private world, live feed (${width} px)`, async ({ page, browser, baseURL }) => {
    test.setTimeout(180_000);
    const height = width === 390 ? 844 : 900;
    await page.setViewportSize({ width, height });

    // --- anonymous: P8 — the public demo world by default ---
    await page.goto("/console");
    await expect(page.getByRole("link", { name: "Mandate home" })).toBeVisible();
    await expect(page.getByTestId("kpi-strip")).toBeVisible();
    await expect(page.getByTestId("demo-badge")).toHaveText("Demo world · simulated money");
    await expect(page.getByTestId("demo-note")).toContainText("Nothing here touches PayPal");
    await expect(page.getByTestId("clock-speed")).toHaveText("1 day / 10 min");
    // The demo world's lender bots funded the pool at creation.
    await expect(page.getByTestId("kpi-notes")).not.toContainText("$0.00");
    await expect(page.getByTestId("advance-1")).toHaveCount(0);
    await expect(page.getByText(LEGAL)).toBeVisible();
    await expect(page.getByTestId("feed-status")).toContainText("live");
    const demoApi = await page.request.get("/api/console/snapshot?world=demo");
    expect(demoApi.status()).toBe(200);
    expect(demoApi.headers()["cache-control"]).toBe("no-store");
    const demoJson = await demoApi.text();
    expect(demoJson).not.toContain("@");
    expect((JSON.parse(demoJson) as { snapshot: { world: { kind: string } } }).snapshot.world.kind).toBe("demo");
    await noHorizontalScroll(page);

    // --- anonymous: the switcher offers the main world (real PayPal sandbox), read-only ---
    const anonSwitcher = page.getByTestId("console-world-switcher").getByLabel("World");
    await expect(anonSwitcher.locator("option")).toHaveText(["Demo world · simulated money", "Main world (real PayPal sandbox)"]);
    await anonSwitcher.selectOption("main");
    await expect(page).toHaveURL(/\/console\?world=main/);
    await expect(page.getByTestId("console-world-switcher")).toContainText("PayPal sandbox");
    await expect(page.getByTestId("demo-badge")).toHaveCount(0);
    await expect(page.getByTestId("advance-1")).toHaveCount(0);
    const api = await page.request.get("/api/console/snapshot");
    expect(api.status()).toBe(200);
    expect(api.headers()["cache-control"]).toBe("no-store");
    expect(await api.text()).not.toContain("@");
    await noHorizontalScroll(page);

    // --- the owner seeds a private world ---
    await signIn(page, `Console Owner ${width}`);
    const created = await page.request.post("/dashboard/worlds/create", {
      form: { name: `Mission ${width}` },
      headers: { origin: baseURL!, accept: "application/json" },
    });
    expect(created.status()).toBe(201);
    const worldId = ((await created.json()) as { world_id: string }).world_id;

    await page.goto("/console");
    const switcher = page.getByTestId("console-world-switcher").getByLabel("World");
    await expect(switcher).toBeVisible();
    await switcher.selectOption(worldId);
    await expect(page).toHaveURL(new RegExp(`/console\\?world=${worldId}`));
    await expect(page.getByTestId("console-sim-day")).toHaveText("Day 0");
    await expect(page.getByTestId("console-world-switcher")).toContainText("sim rail");

    // +7 days through the console's clock controls (the world's advance route).
    await page.getByTestId("advance-7").click();
    await expect(page.getByTestId("console-sim-day")).toHaveText("Day 7", { timeout: 60_000 });
    await expect(page.getByTestId("paypal-log-row").first()).toBeVisible();
    await expect(page.getByTestId("kpi-notes")).not.toContainText("$0.00");
    await expect(page.getByTestId("kpi-allowance")).toContainText("gross of holder loss sharing");
    await expect(page.getByTestId("treasury-headline")).not.toContainText("No treasury memo yet");
    await expect(page.getByTestId("flow-ticker").locator("li").first()).not.toHaveText("No money has moved yet.");

    // Grids: ledger by default, then loans with a filter, notes, agents.
    await expect(page.getByTestId("grid-ledger").getByRole("gridcell").first()).toBeVisible();
    await page.getByTestId("tab-loans").click();
    await expect(page.getByRole("tab", { name: /Loans/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("grid-loans").getByRole("gridcell").first()).toBeVisible();
    await page.getByTestId("tab-notes").click();
    await expect(page.getByTestId("grid-notes").getByRole("gridcell").first()).toBeVisible();
    await page.getByTestId("tab-agents").click();
    const agentRows = page.getByTestId("grid-agents").getByRole("row").filter({ has: page.getByRole("gridcell") });
    await expect(agentRows.first()).toBeVisible();
    await page.getByTestId("grid-filter").fill("zzzz-no-such-agent");
    await expect(agentRows).toHaveCount(0);
    await page.getByTestId("grid-filter").fill("");
    await expect(agentRows.first()).toBeVisible();
    await page.getByTestId("tab-ledger").click();

    // No PII anywhere on the page or in the API.
    const mine = await page.request.get(`/api/console/snapshot?world=${worldId}`);
    expect(mine.status()).toBe(200);
    const json = await mine.text();
    expect(json).not.toContain("@");
    expect(json).not.toMatch(/\b[A-Z0-9]{13}\b/);
    expect(await page.locator("main").innerText()).not.toContain("@");

    // Live feed: a clock move made elsewhere shows up here by polling in < 3 s.
    const moved = await page.request.post(`/dashboard/worlds/${worldId}/advance`, {
      form: { days: "1" },
      headers: { origin: baseURL!, accept: "application/json" },
    });
    expect(moved.status()).toBe(200);
    const started = Date.now();
    await expect(page.getByTestId("console-sim-day")).toHaveText("Day 8", { timeout: 3000 });
    expect(Date.now() - started).toBeLessThan(3000);

    await page.waitForTimeout(1500); // let the bursts settle for the screenshot
    await noHorizontalScroll(page);
    await page.screenshot({ path: join(SCREENSHOTS, `p6-console-${width}.png`), fullPage: true });

    // --- a stranger can't see the owner's world ---
    const stranger = await browser.newContext({ viewport: { width, height } });
    const strangerPage = await stranger.newPage();
    const strangerApi = await strangerPage.request.get(`${baseURL}/api/console/snapshot?world=${worldId}`);
    expect(strangerApi.status()).toBe(404);
    await strangerPage.goto(`${baseURL}/console?world=${worldId}`);
    await expect(strangerPage.getByText("This page could not be found")).toBeVisible();
    await stranger.close();
  });
}

test("P6: the landing page links to the console", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Watch the bank live →" }).click();
  await expect(page).toHaveURL(/\/console$/);
  await expect(page.getByTestId("kpi-strip")).toBeVisible();
  await expect(page.getByTestId("demo-badge")).toBeVisible();
  const agentsMd = await page.request.get("/agents.md");
  expect(await agentsMd.text()).toContain("/console");
});
