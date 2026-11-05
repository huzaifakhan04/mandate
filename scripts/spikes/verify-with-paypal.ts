/**
 * Spike: fallback for "Log in with PayPal" (whose redirect_uri can't be
 * registered without developer.paypal.com access — see
 * login-with-paypal.md). A "Verify with PayPal" flow instead: a $0.01
 * order the owner approves (Playwright login), then captured, reading
 * payer.email_address / payer.payer_id off the capture/order response.
 *
 * Run: npx tsx --env-file=.env.local scripts/spikes/verify-with-paypal.ts
 */
import { chromium } from "@playwright/test";

import * as orders from "@/server/paypal/orders";
import { paypalConfig } from "@/server/paypal/config";
import { getAccessToken } from "@/server/paypal/token";
import { spikeDb, requireEnv } from "./_helpers";

async function approveAsBuyer(approveUrl: string, email: string, password: string) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(approveUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1000);

    const emailField = page.locator("#email");
    await emailField.waitFor({ timeout: 15000 });
    await emailField.fill(email);
    await page.locator("#btnNext").click();

    const passwordField = page.locator("#password");
    await passwordField.waitFor({ timeout: 15000, state: "visible" });
    await page.waitForTimeout(800);
    await passwordField.click();
    await passwordField.pressSequentially(password, { delay: 30 });
    await page.locator("#btnLogin").click();
    await page.waitForTimeout(2500);

    const errorBanner = page.locator("[role='alert'], .error, #loginErrorAlert").first();
    const errorText = (await errorBanner.isVisible().catch(() => false))
      ? ((await errorBanner.textContent().catch(() => null))?.trim() ?? null)
      : null;
    if (errorText) {
      return { ok: false, errorText };
    }

    const payButton = page.locator("#payment-submit-btn, #confirmButtonTop, button:has-text('Continue')").first();
    await payButton.waitFor({ timeout: 20000 });
    await payButton.click();
    await page.waitForTimeout(3000);
    return { ok: true, errorText: null };
  } catch (err) {
    return { ok: false, errorText: err instanceof Error ? err.message : String(err) };
  } finally {
    await browser.close();
  }
}

async function getRawOrder(orderId: string): Promise<unknown> {
  const { baseUrl } = paypalConfig();
  const token = await getAccessToken();
  const res = await fetch(`${baseUrl}/v2/checkout/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

async function main() {
  const owner = requireEnv("PAYPAL_OWNER_EMAIL");
  const ownerPassword = requireEnv("PAYPAL_OWNER_PASSWORD");
  const baseUrl = requireEnv("PUBLIC_BASE_URL");
  const { db, worldId } = await spikeDb();

  const created = await orders.create(db, {
    worldId,
    amountCents: 1n,
    description: "Spike: verify-with-paypal",
    customId: "spike-verify-with-paypal",
    returnUrl: `${baseUrl}/return`,
    cancelUrl: `${baseUrl}/cancel`,
  });
  console.log("created:", JSON.stringify(created));

  const approval = await approveAsBuyer(created.approveUrl, owner, ownerPassword);
  console.log("approval:", JSON.stringify(approval));

  if (!approval.ok) {
    console.log("STOPPED: owner approval did not complete, skipping capture.");
    return;
  }

  const captured = await orders.capture(db, { worldId, orderId: created.orderId });
  console.log("captured:", JSON.stringify(captured));

  const raw = (await getRawOrder(created.orderId)) as {
    payer?: { email_address?: string; payer_id?: string };
  };
  console.log("payer on order:", JSON.stringify(raw.payer ?? null));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
