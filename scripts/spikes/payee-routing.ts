/**
 * Spike: create an order whose purchase_unit `payee` is
 * PAYPAL_BANK_EMAIL (the bank's own merchant account, not the sandbox
 * app's default merchant), approve it headlessly as PAYPAL_CLIENT_EMAIL,
 * capture it, and confirm the capture lands with the bank as payee.
 *
 * Run: npx tsx --env-file=.env.local scripts/spikes/payee-routing.ts
 */
import { chromium } from "@playwright/test";

import * as orders from "@/server/paypal/orders";
import { paypalConfig } from "@/server/paypal/config";
import { getAccessToken } from "@/server/paypal/token";
import { spikeDb, requireEnv } from "./_helpers";

interface ApprovalResult {
  ok: boolean;
  guestOptionSeen: boolean;
  errorText: string | null;
  finalUrl: string;
}

async function approveAsBuyer(approveUrl: string, email: string, password: string): Promise<ApprovalResult> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let guestOptionSeen = false;
  try {
    await page.goto(approveUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1000);

    // Look for a guest/card checkout option before logging in.
    const guestLink = page.getByText(/pay with debit or credit card|guest/i).first();
    guestOptionSeen = await guestLink.isVisible().catch(() => false);

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
      return { ok: false, guestOptionSeen, errorText, finalUrl: page.url() };
    }

    const payButton = page.locator("#payment-submit-btn, #confirmButtonTop, button:has-text('Continue')").first();
    await payButton.waitFor({ timeout: 20000 });
    await payButton.click();
    await page.waitForTimeout(3000);

    return { ok: true, guestOptionSeen, errorText: null, finalUrl: page.url() };
  } catch (err) {
    return {
      ok: false,
      guestOptionSeen,
      errorText: err instanceof Error ? err.message : String(err),
      finalUrl: page.url(),
    };
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
  const bankEmail = requireEnv("PAYPAL_BANK_EMAIL");
  const clientEmail = requireEnv("PAYPAL_CLIENT_EMAIL");
  const clientPassword = requireEnv("PAYPAL_CLIENT_PASSWORD");
  const baseUrl = requireEnv("PUBLIC_BASE_URL");
  const { db, worldId } = await spikeDb();

  const t0 = Date.now();
  const created = await orders.create(db, {
    worldId,
    amountCents: 150n,
    description: "Spike: payee-routing",
    customId: "spike-payee-routing",
    payeeEmail: bankEmail,
    returnUrl: `${baseUrl}/return`,
    cancelUrl: `${baseUrl}/cancel`,
  });
  console.log("created:", JSON.stringify(created));

  const approval = await approveAsBuyer(created.approveUrl, clientEmail, clientPassword);
  console.log("approval:", JSON.stringify(approval));

  if (!approval.ok) {
    console.log(
      `total ms: ${Date.now() - t0} -- STOPPED: buyer approval did not complete, skipping capture.`,
    );
    return;
  }

  const captured = await orders.capture(db, { worldId, orderId: created.orderId });
  console.log("captured:", JSON.stringify(captured));

  const raw = await getRawOrder(created.orderId);
  console.log("raw order after capture:", JSON.stringify(raw, null, 2));
  console.log(`total ms: ${Date.now() - t0}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
