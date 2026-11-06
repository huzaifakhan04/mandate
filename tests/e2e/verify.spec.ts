import { expect, test } from "@playwright/test";

// No PayPal here: /verify/start would create a real sandbox order on the dev
// server's main world, so the start → approve round trip is covered by the
// sim-rail unit tests (tests/unit/app/verify.test.ts) instead.

test("P2: /verify renders the sign-in form carrying a sanitized return_to", async ({ page }) => {
  await page.goto("/verify?return_to=%2F%2Fevil.example.com");
  await expect(page.getByRole("heading", { name: "Verify with PayPal" })).toBeVisible();
  await expect(page.locator('form[action="/verify/start"] input[name="return_to"]')).toHaveValue("/dashboard");

  await page.goto("/verify?return_to=%2Fclaim%2Fabc");
  await expect(page.locator('form[action="/verify/start"] input[name="return_to"]')).toHaveValue("/claim/abc");
});

test("P2: /dashboard without a session sends the human to /verify", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/verify\?return_to=%2Fdashboard$/);
  await expect(page.getByRole("button", { name: "Verify with PayPal" })).toBeVisible();
});

test("P2: /verify/return without the browser's verify cookie shows the error page", async ({ page }) => {
  await page.goto("/verify/return?token=SIMORDER-UNKNOWN");
  await expect(page).toHaveURL(/\/verify\/error\?reason=session_mismatch$/);
  await expect(page.getByText("started in a different browser")).toBeVisible();
});

test("P2: a cross-origin POST to /verify/start or /logout is refused", async ({ request }) => {
  for (const path of ["/verify/start", "/logout"]) {
    const response = await request.post(path, {
      headers: { origin: "https://evil.example.com" },
      form: {},
      maxRedirects: 0,
    });
    expect(response.status()).toBe(403);
  }
});
