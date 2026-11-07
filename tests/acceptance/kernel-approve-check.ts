/**
 * P7 (Kernel sponsor) — a focused check that one PayPal *sandbox* checkout
 * can be approved from a Kernel cloud browser:
 *
 *   npx tsx --env-file=.env.local tests/acceptance/kernel-approve-check.ts [--account LENDER] [--browser kernel|local]
 *
 * Creates a $1.00 sandbox order (never captured — no money moves; it just
 * expires), approves it as PAYPAL_<account> through
 * tests/helpers/kernelApprove.ts (create browser → Playwright over CDP →
 * paypalApprove's page logic → delete browser), then reads the order back
 * and passes when PayPal reports it APPROVED. A captcha / security
 * challenge is reported as BLOCKED and never bypassed (stealth stays off).
 * `--browser local` runs the same check in a local Chromium (to compare).
 */
import { resolve } from "path";

import { paypalConfig } from "@/server/paypal/config";
import { getAccessToken } from "@/server/paypal/token";

import { approvePayPalCheckoutViaKernel } from "../helpers/kernelApprove";
import { approvePayPalCheckout } from "../helpers/paypalApprove";
import { requireEnv, type SandboxAccount } from "../helpers/sandboxServer";

const RETURN_URL = "https://agentic-bank-mu.vercel.app/kernel-check/return";

async function main(): Promise<void> {
  const index = process.argv.indexOf("--account");
  const account = (index === -1 ? "LENDER" : process.argv[index + 1]) as SandboxAccount;
  const browserIndex = process.argv.indexOf("--browser");
  const browser = browserIndex === -1 ? "kernel" : process.argv[browserIndex + 1];
  const approve = browser === "local" ? approvePayPalCheckout : approvePayPalCheckoutViaKernel;
  const { baseUrl } = paypalConfig();
  const headers = { Authorization: `Bearer ${await getAccessToken()}`, "Content-Type": "application/json" };

  const order = (await (
    await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: "1.00" }, description: "Mandate test: Kernel approval check (never captured)" }],
        payment_source: { paypal: { experience_context: { return_url: RETURN_URL, cancel_url: `${RETURN_URL}/cancel` } } },
      }),
    })
  ).json()) as { id: string; links: { rel: string; href: string }[] };
  const link = order.links.find((l) => l.rel === "payer-action" || l.rel === "approve");
  if (!link) {
    throw new Error("sandbox order has no approve link");
  }
  console.log(`[kernel-check] order ${order.id} created; approving as ${account} in a ${browser === "local" ? "local Chromium" : "Kernel"} browser…`);

  const result = await approve(link.href, {
    email: requireEnv(`PAYPAL_${account}_EMAIL`),
    password: requireEnv(`PAYPAL_${account}_PASSWORD`),
    returnUrlPrefix: RETURN_URL,
    screenshotDir: resolve("test-results/kernel"),
    label: `${browser}-${account.toLowerCase()}`,
  });
  const after = (await (await fetch(`${baseUrl}/v2/checkout/orders/${order.id}`, { headers })).json()) as { status: string };
  const verdict = result.blocked ? "BLOCKED" : result.ok && after.status === "APPROVED" ? "PASS" : "FAIL";
  console.log(
    `[kernel-check] ${verdict}: approval ok=${result.ok} blocked=${result.blocked} in ${result.ms} ms; ` +
      `order status=${after.status}${result.errorText ? `; error: ${result.errorText}` : ""}` +
      `${result.screenshotPath ? `; screenshot: ${result.screenshotPath}` : ""}`,
  );
  process.exit(verdict === "PASS" ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
