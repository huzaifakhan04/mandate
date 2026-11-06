import { join } from "path";

import { expect, test, type Page } from "@playwright/test";

/**
 * P2 Task 6: a private sandbox world in the browser, at 1280 and 390 px —
 * create it (bots seeded on the sim rail), move the clock +7 / +1 (the
 * bots act each day), register an agent into it (path B with a world),
 * switch the dashboard to it and back to main (where it doesn't show),
 * then reset (a fresh world; the old URL 404s).
 */

const SCREENSHOTS = join(process.cwd(), "docs", "design", "screenshots");

async function signIn(page: Page, name: string) {
  const response = await page.request.post("/api/test/session", {
    form: { name, return_to: "/dashboard" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
}

for (const width of [1280, 390]) {
  test(`P2: sandbox world — create, clock, path B, switcher, reset (${width} px)`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await signIn(page, "Grace Tester");

    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Sandbox worlds" }).first().click();
    await expect(page.getByRole("heading", { name: "Sandbox worlds" })).toBeVisible();
    await page.getByLabel("World name").fill(`Judges ${width}`);
    await page.getByRole("button", { name: "Create world" }).click();

    await expect(page.getByTestId("world-name")).toHaveText(`Judges ${width}`);
    await expect(page.getByTestId("sim-date")).toContainText("Day 0");
    await expect(page.getByTestId("bot-card")).toHaveCount(4);
    await expect(page.getByTestId("stat-notes")).toContainText("$350.00");
    await expect(page.getByText("Sandbox model · simulated money")).toBeAttached();

    await page.getByRole("button", { name: "+7 days" }).click();
    await expect(page.getByTestId("sim-date")).toContainText("Day 7");
    await page.getByRole("button", { name: "+1 day" }).click();
    await expect(page.getByTestId("sim-date")).toContainText("Day 8");
    await expect(page.getByTestId("day-log")).toContainText("Day 8");
    await expect(page.getByTestId("trial-balance")).toHaveText("$0.00");
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("world-name")).toBeVisible();
    await page.screenshot({ path: join(SCREENSHOTS, `p2-world-${width}.png`), fullPage: true });
    const worldUrl = page.url().split("?")[0]!;

    // Path B into this world.
    await page.getByRole("link", { name: "+ Register an agent here" }).click();
    await page.getByLabel("Agent name").fill(`Sandboxed ${width}`);
    await page.getByLabel("Operator").fill("Tester");
    await page.getByLabel("Model").fill("Claude");
    await page.getByLabel("Payout PayPal account").fill("sandboxed@example.com");
    await expect(page.locator("#r-world")).toHaveValue(worldUrl.split("/").pop()!);
    await page.getByRole("button", { name: "Register agent" }).click();
    await expect(page.getByText("mnd_", { exact: false }).first()).toBeVisible();

    // The world's dashboard shows it; the main one doesn't.
    await page.goto(`/dashboard?world=${worldUrl.split("/").pop()}`);
    await expect(page.getByTestId("world-banner")).toBeVisible();
    await expect(page.getByText(`Sandboxed ${width}`).first()).toBeVisible();
    await page.getByTestId("world-switcher").getByLabel("World").selectOption("");
    await page.getByTestId("world-switcher").getByRole("button", { name: "Go" }).click();
    await expect(page.getByTestId("world-banner")).toHaveCount(0);
    await expect(page.getByText(`Sandboxed ${width}`)).toHaveCount(0);

    // Reset: a fresh world, the old one is gone.
    await page.goto(worldUrl);
    await page.getByRole("button", { name: "Reset" }).click();
    await expect(page.getByText("Fresh world opened")).toBeVisible();
    await expect(page.getByTestId("sim-date")).toContainText("Day 0");
    expect(page.url().split("?")[0]).not.toBe(worldUrl);
    // (The page streams inside Suspense, so notFound() renders the 404 page
    // rather than changing the status; the routes' 404s are unit-tested.)
    await page.goto(worldUrl);
    await expect(page.getByText("This page could not be found")).toBeVisible();
    await expect(page.getByTestId("clock-controls")).toHaveCount(0);
  });
}
