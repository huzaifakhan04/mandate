import { chromium, type Page } from "@playwright/test";

import { approveOnPage, type ApproveResult, PAYPAL_GENERIC_ERROR } from "./paypalApprove";
import { PAYPAL_RETRY_PAUSE_MS, requireEnv, type SandboxAccount } from "./sandboxServer";

/**
 * P2 Task 7 — the human owner's steps, in a real browser against a running
 * bank (local `next dev` or a deployed base), the way a person does them:
 *
 * 1. open the agent's `claim_url`;
 * 2. click **Verify with PayPal** → log in to PayPal sandbox as
 *    `PAYPAL_<account>` and approve the $0.01 identity order (never
 *    captured) → PayPal returns to `/verify/return`, which sets the
 *    `mandate_session` cookie and sends the browser back to the claim page;
 * 3. click **Claim agent**;
 * 4. open the dashboard drawer for the agent → **Sign a mandate / Edit
 *    mandate** → fill the limits → type the full name → tick agree → submit.
 *
 * One browser context throughout, so the session cookie from step 2 is
 * what steps 3–4 use. No bot-check circumvention (see paypalApprove.ts): a
 * PayPal challenge stops the flow with `blocked`. The claim URL is a
 * bearer secret and is never logged; the password is only typed into
 * PayPal's form.
 */

export interface MandateFormValues {
  /** Dollars, as the human types them. */
  maxPerLoanUsd: string;
  maxTotalOwedUsd: string;
  /** Percent of the principal. */
  maxFeePct: string;
  maxTermDays: string;
  collateral: Array<"invoice_link" | "none">;
}

export interface OwnerStepsOptions {
  claimUrl: string;
  /** The bank's base URL (where PayPal returns to). */
  base: string;
  agentId: string;
  account: SandboxAccount;
  mandate: MandateFormValues;
  /** The name the human types to sign. */
  signerName: string;
  screenshotDir: string;
  label: string;
  headless?: boolean;
}

export interface OwnerStepsResult {
  ok: boolean;
  /** PayPal showed a captcha / security challenge: stop, don't retry. */
  blocked: boolean;
  /** Which step failed, and why. */
  errorText: string | null;
  screenshotPath: string | null;
  /** The drawer's tier after signing (e.g. "T1"). */
  tier: string | null;
  timingsMs: { verified?: number; claimed?: number; mandateSigned?: number };
  /** Verify with PayPal attempts (each creates one identity order; >1 after PayPal's transient error page). */
  verifyAttempts: number;
  ms: number;
}

async function shot(page: Page, dir: string, label: string): Promise<string | null> {
  const path = `${dir}/owner-${label}-${Date.now()}.png`;
  return page
    .screenshot({ path, fullPage: true })
    .then(() => path)
    .catch(() => null);
}

export async function claimAndSignMandateAsHuman(options: OwnerStepsOptions): Promise<OwnerStepsResult> {
  const started = Date.now();
  const timingsMs: OwnerStepsResult["timingsMs"] = {};
  let verifyAttempts = 0;
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext();
  // Against `next dev`, Turbopack intermittently falls into a full-reload
  // loop on the claim page (each render rewrites a .next/dev manifest →
  // "Compiled in 0ms" → HMR reload; seen as hundreds of GET /claim/… with no
  // source change), so no click can land. A human never meets dev HMR (prod
  // has none): mock the HMR websocket (never connected to the server) so the
  // page is a plain page. A no-op on a deployed base.
  await context.routeWebSocket(/\/_next\/(webpack-)?hmr/, () => undefined);
  const page = await context.newPage();
  const fail = async (errorText: string, approval?: ApproveResult): Promise<OwnerStepsResult> => ({
    ok: false,
    blocked: approval?.blocked ?? false,
    errorText,
    screenshotPath: approval?.screenshotPath ?? (await shot(page, options.screenshotDir, options.label)),
    tier: null,
    timingsMs,
    verifyAttempts,
    ms: Date.now() - started,
  });

  try {
    // 1–2. The claim page → Verify with PayPal → approve as the owner → back
    //      on the claim page. PayPal sandbox's transient error page gets one
    //      retry (a fresh identity order) after a pause.
    for (let attempt = 1; ; attempt += 1) {
      verifyAttempts = attempt;
      await page.goto(options.claimUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const verify = page.getByRole("button", { name: /^Verify with PayPal/ });
      await verify.waitFor({ state: "visible", timeout: 30_000 });
      await verify.click();
      await page.waitForURL(/paypal\.com/, { timeout: 60_000 });
      const approval = await approveOnPage(page, {
        email: requireEnv(`PAYPAL_${options.account}_EMAIL`),
        password: requireEnv(`PAYPAL_${options.account}_PASSWORD`),
        returnUrlPrefix: `${options.base}/verify/return`,
        screenshotDir: options.screenshotDir,
        label: `${options.label}-verify${attempt > 1 ? "-retry" : ""}`,
      });
      if (approval.ok) {
        break;
      }
      if (attempt === 1 && !approval.blocked && approval.errorText === PAYPAL_GENERIC_ERROR) {
        console.warn(`[owner] Verify with PayPal hit PayPal's transient error page; retrying in ${PAYPAL_RETRY_PAUSE_MS / 1000}s`);
        await context.clearCookies();
        await page.waitForTimeout(PAYPAL_RETRY_PAUSE_MS);
        continue;
      }
      return await fail(`Verify with PayPal: ${approval.errorText ?? "not approved"}`, approval);
    }
    await page.waitForURL((url) => url.pathname.startsWith("/claim/") || url.pathname.startsWith("/verify/error"), {
      timeout: 60_000,
    });
    if (new URL(page.url()).pathname.startsWith("/verify/error")) {
      return await fail(`Verify with PayPal failed: /verify/error?${new URL(page.url()).searchParams.toString()}`);
    }
    timingsMs.verified = Date.now() - started;

    // 3. Claim agent.
    const claim = page.getByRole("button", { name: "Claim agent" });
    await claim.waitFor({ state: "visible", timeout: 30_000 });
    await claim.click();
    await page.getByTestId("claim-yours").waitFor({ state: "visible", timeout: 30_000 });
    timingsMs.claimed = Date.now() - started;

    // 4. The dashboard drawer → the mandate form.
    const signed = await signMandateInDrawer(page, options.base, options.agentId, options.mandate, options.signerName);
    if (!signed.ok) {
      return await fail(`mandate form: ${signed.notice}`);
    }
    timingsMs.mandateSigned = Date.now() - started;
    const tier = signed.tier;
    return { ok: true, blocked: false, errorText: null, screenshotPath: null, tier, timingsMs, verifyAttempts, ms: Date.now() - started };
  } catch (err) {
    return await fail(err instanceof Error ? err.message.split("\n")[0]! : String(err));
  } finally {
    await browser.close();
  }
}

/**
 * The owner's mandate form in the dashboard drawer (the signed-in `page`):
 * open `/dashboard?agent=<id>`, fill the limits, type the name, agree and
 * sign. Returns the drawer's notice text and the tier it then shows.
 */
export async function signMandateInDrawer(
  page: Page,
  base: string,
  agentId: string,
  mandate: MandateFormValues,
  signerName: string,
): Promise<{ ok: boolean; notice: string; tier: string | null }> {
  await page.goto(`${base}/dashboard?agent=${encodeURIComponent(agentId)}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const drawer = page.getByTestId("agent-drawer");
  await drawer.waitFor({ state: "visible", timeout: 30_000 });
  const perLoan = drawer.getByLabel("Max per loan");
  if (!(await perLoan.isVisible().catch(() => false))) {
    await drawer.getByTestId("edit-mandate").click();
  }
  await perLoan.fill(mandate.maxPerLoanUsd);
  await drawer.getByLabel("Max total owed").fill(mandate.maxTotalOwedUsd);
  await drawer.getByLabel("Max fee").fill(mandate.maxFeePct);
  await drawer.getByLabel("Max term").fill(mandate.maxTermDays);
  for (const kind of ["invoice_link", "none"] as const) {
    const box = drawer.locator(`input[name="eligible_collateral"][value="${kind}"]`);
    await box.setChecked(mandate.collateral.includes(kind));
  }
  await drawer.getByLabel("Type your full name to sign").fill(signerName);
  await drawer.getByLabel("I agree to the mandate above.").check();
  await drawer.getByRole("button", { name: /^Sign (mandate|version \d+)$/ }).click();
  const notice = drawer.getByTestId("drawer-notice");
  await notice.waitFor({ state: "visible", timeout: 30_000 });
  const text = (await notice.textContent())?.trim() ?? "";
  const tier = (await drawer.getByTestId("drawer-tier").textContent())?.trim() ?? null;
  return { ok: text.includes("Mandate signed"), notice: text, tier };
}
