import { expect, test } from "@playwright/test";

// P2 Task 2: the claim page. Signing in needs a PayPal round trip, so the
// signed-in states (confirm / claimed by you / taken) are covered by the
// sim-rail unit tests (tests/unit/services/claims.test.ts, tests/unit/app/claim.test.ts).

async function registerClaimPath(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const response = await request.post("/api/v1/register_agent", {
    data: { name: "E2E Claimer", operator: "E2E Ops", model: "e2e-model", payout_email: "claimer@example.com" },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { data: { claim_url: string; tier: number } };
  expect(body.data.tier).toBe(0);
  // PUBLIC_BASE_URL may point elsewhere; the path is what this server serves.
  return new URL(body.data.claim_url).pathname;
}

test("P2: a fresh claim link asks the human to verify with PayPal, returning to the claim page (390 px)", async ({
  page,
  request,
}) => {
  const path = await registerClaimPath(request);
  expect(path).toMatch(/^\/claim\/[A-Za-z0-9_-]{43}$/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "Claim E2E Claimer" })).toBeVisible();
  await expect(page.getByText("E2E Ops")).toBeVisible();
  await expect(page.getByText("e2e-model")).toBeVisible();
  await expect(page.locator('form[action="/verify/start"] input[name="return_to"]')).toHaveValue(path);
  await expect(page.getByRole("button", { name: "Verify with PayPal to claim E2E Claimer" })).toBeVisible();
  await expect(page.getByText("not deposits and not FDIC-insured")).toBeVisible();
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("P2: an unknown claim link shows a clear invalid-link page", async ({ page }) => {
  await page.goto(`/claim/${"A".repeat(43)}`);
  await expect(page.getByRole("heading", { name: "This claim link doesn't work" })).toBeVisible();
});

test("P2: a cross-origin POST to the claim action is refused", async ({ request }) => {
  const path = await registerClaimPath(request);
  const response = await request.post(`${path}/accept`, {
    headers: { origin: "https://evil.example.com" },
    form: {},
    maxRedirects: 0,
  });
  expect(response.status()).toBe(403);
});
