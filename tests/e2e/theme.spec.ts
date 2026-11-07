import { expect, test, type Page } from "@playwright/test";

/**
 * P10 redesign guard: every route renders the one dark theme and none of the
 * "AI slop" surface tells come back (gradients, glass/blur, horizontal page
 * scroll), at desktop and phone widths.
 */

const BG = "rgb(8, 9, 10)";

const PUBLIC_ROUTES = [
  "/",
  "/console",
  "/sdks",
  "/verify",
  "/verify/error",
  "/claim/not-a-real-token",
  "/checkout/notes/return?token=SIMORDER-UNKNOWN",
  "/checkout/invoice/cancel",
];

const OWNER_ROUTES = ["/dashboard", "/dashboard/worlds", "/dashboard/agents/new"];

async function signIn(page: Page, name: string) {
  const response = await page.request.post("/api/test/session", {
    form: { name, return_to: "/dashboard" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
}

/** Collects every element whose computed style uses a gradient or a backdrop blur. */
async function slopTells(page: Page) {
  return page.evaluate(() => {
    const hits: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      // Third-party widget internals (Bryntum, AG Grid) are themed separately.
      if (el.closest(".b-widget, .ag-root-wrapper")) continue;
      const cs = window.getComputedStyle(el);
      const describe = () => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`;
      if (cs.backgroundImage.includes("gradient")) hits.push(`gradient: ${describe()}`);
      const blur = cs.backdropFilter || (cs as unknown as Record<string, string>).webkitBackdropFilter || "none";
      if (blur !== "none") hits.push(`backdrop-filter: ${describe()}`);
    }
    return hits;
  });
}

async function assertTheme(page: Page, route: string) {
  await page.goto(route);
  await page.waitForLoadState("networkidle").catch(() => {});

  const style = await page.evaluate(() => ({
    bg: window.getComputedStyle(document.body).backgroundColor,
    scheme: window.getComputedStyle(document.documentElement).colorScheme,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(style.bg, `${route} body background`).toBe(BG);
  expect(style.scheme, `${route} color-scheme`).toContain("dark");
  expect(style.overflow, `${route} horizontal page scroll`).toBeLessThanOrEqual(1);
  expect(await slopTells(page), `${route} gradients / blur`).toEqual([]);
}

for (const width of [1280, 390]) {
  test.describe(`P10: dark theme at ${width} px`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } });

    test("public routes are dark, flat and do not scroll sideways", async ({ page }) => {
      for (const route of PUBLIC_ROUTES) await assertTheme(page, route);
    });

    test("owner routes are dark, flat and do not scroll sideways", async ({ page }) => {
      await signIn(page, `Theme Owner ${width}`);
      for (const route of OWNER_ROUTES) await assertTheme(page, route);
    });

    test("the primary action shows a visible keyboard focus ring", async ({ page }) => {
      await page.goto("/");
      const cta = page.getByRole("link", { name: "Watch the bank live →" });
      await cta.focus();
      const outline = await cta.evaluate((el) => {
        const cs = window.getComputedStyle(el);
        return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
      });
      expect(outline.style).not.toBe("none");
      expect(outline.width).toBeGreaterThanOrEqual(1);
    });
  });
}
