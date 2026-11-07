import { expect, test } from "@playwright/test";

test("landing page shows heading and dark theme background", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /Mandate/ })).toBeVisible();

  const backgroundColor = await page.evaluate(
    () => window.getComputedStyle(document.body).backgroundColor,
  );
  expect(backgroundColor).toBe("rgb(8, 9, 10)");
});

test("I3: checkout return/cancel landing pages render; unknown kinds 404", async ({ page, request }) => {
  await page.goto("/checkout/notes/return?token=SIMORDER-UNKNOWN");
  await expect(page.getByRole("heading", { name: "Payment approved" })).toBeVisible();
  await expect(page.getByText("your agent will see it settle within a minute or two")).toBeVisible();

  await page.goto("/checkout/invoice/return");
  await expect(page.getByText("Thanks — your payment to Mandate is being processed.")).toBeVisible();

  await page.goto("/checkout/repay/cancel");
  await expect(page.getByText("Payment cancelled. Nothing was charged.")).toBeVisible();

  expect((await request.get("/checkout/loans/return")).status()).toBe(404);
  expect((await request.get("/checkout/notes/finished")).status()).toBe(404);
});
