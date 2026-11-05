import { expect, test } from "@playwright/test";

test("landing page shows heading and light theme background", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /Mandate/ })).toBeVisible();

  const backgroundColor = await page.evaluate(
    () => window.getComputedStyle(document.body).backgroundColor,
  );
  expect(backgroundColor).toBe("rgb(255, 255, 255)");
});
