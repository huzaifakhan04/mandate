import { mkdirSync } from "fs";
import { join } from "path";

import { chromium, type Page } from "@playwright/test";

/**
 * Task 10 — approves a PayPal sandbox checkout (an order's approve /
 * payer-action URL) as a sandbox personal account, headlessly. Reuses the
 * day-1 spike login flow: email →
 * Next → password → Log In → the review page's pay/continue button.
 *
 * No bot-check circumvention: plain Playwright Chromium, no user-agent
 * spoofing. If PayPal shows a captcha / security challenge the helper
 * stops and reports `blocked` (with a screenshot) rather than trying to
 * get past it. The password is typed into the form only — never logged.
 */

export interface ApproveOptions {
  email: string;
  password: string;
  /** When set, approval only counts once PayPal redirects to a URL starting with this. */
  returnUrlPrefix?: string;
  /** Where to save a screenshot when approval fails or is blocked. */
  screenshotDir?: string;
  /** A short label for the screenshot file name. */
  label?: string;
  headless?: boolean;
}

export interface ApproveResult {
  ok: boolean;
  /** PayPal showed a captcha / security challenge: stop, don't retry. */
  blocked: boolean;
  /** PayPal's own error banner text (e.g. bad credentials, rate limit), or the failure message. */
  errorText: string | null;
  /** The final URL with its query string dropped (order tokens are not secrets, but keep logs short). */
  finalUrl: string;
  screenshotPath: string | null;
  ms: number;
}

const CHALLENGE_TEXT = /captcha|security challenge|quick security check|verify (it's|it is) you|confirm (it's|it is) you|i'?m not a robot/i;

async function challengeVisible(page: Page): Promise<boolean> {
  const frames = page.frames().map((frame) => frame.url());
  if (frames.some((url) => /recaptcha|hcaptcha|arkoselabs|funcaptcha/i.test(url))) {
    return true;
  }
  const text = await page
    .locator("body")
    .innerText({ timeout: 2_000 })
    .catch(() => "");
  return CHALLENGE_TEXT.test(text);
}

/**
 * PayPal sandbox's transient "Things don't appear to be working at the
 * moment" page (seen after several logins of one account in a short
 * time). Not a challenge: callers may retry the approval after a pause.
 */
export const PAYPAL_GENERIC_ERROR = "PayPal error page: things don't appear to be working at the moment";

async function genericErrorPage(page: Page): Promise<boolean> {
  const text = await page
    .locator("body")
    .innerText({ timeout: 2_000 })
    .catch(() => "");
  return /things don.t appear to be working/i.test(text);
}

async function errorBannerText(page: Page): Promise<string | null> {
  const banner = page.locator("#loginErrorAlert, .notifications [role='alert'], [role='alert']").first();
  if (!(await banner.isVisible().catch(() => false))) {
    return null;
  }
  const text = (await banner.textContent().catch(() => null))?.trim();
  return text ? text : null;
}

function stripQuery(url: string): string {
  const index = url.indexOf("?");
  return index === -1 ? url : url.slice(0, index);
}

export async function approvePayPalCheckout(approveUrl: string, options: ApproveOptions): Promise<ApproveResult> {
  const started = Date.now();
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const page = await browser.newPage();
  try {
    try {
      await page.goto(approveUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (err) {
      return await approvalResult(page, options, started, false, false, err instanceof Error ? err.message.split("\n")[0]! : String(err));
    }
    return await approveOnPage(page, options, started);
  } finally {
    await browser.close();
  }
}

/** A failed (not blocked) result for `page`, with a screenshot — for helpers that drive their own browser (e.g. kernelApprove). */
export function approvalFailure(page: Page, options: ApproveOptions, started: number, errorText: string): Promise<ApproveResult> {
  return approvalResult(page, options, started, false, false, errorText);
}

/** Builds the result (with a screenshot when it failed). */
async function approvalResult(
  page: Page,
  options: ApproveOptions,
  started: number,
  ok: boolean,
  blocked: boolean,
  errorText: string | null,
): Promise<ApproveResult> {
  let screenshotPath: string | null = null;
  if (!ok && options.screenshotDir) {
    mkdirSync(options.screenshotDir, { recursive: true });
    screenshotPath = join(options.screenshotDir, `paypal-${options.label ?? "approve"}-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {
      screenshotPath = null;
    });
  }
  return { ok, blocked, errorText, finalUrl: stripQuery(page.url()), screenshotPath, ms: Date.now() - started };
}

/**
 * Logs in and approves on a page that is already on (or navigating to)
 * PayPal's checkout — e.g. after a form on our own site 303'd there, so
 * the cookies our site sets on return land in the same browser context.
 * Leaves the page open; the caller owns the browser.
 */
export async function approveOnPage(page: Page, options: ApproveOptions, started = Date.now()): Promise<ApproveResult> {
  const finish = (ok: boolean, blocked: boolean, errorText: string | null) =>
    approvalResult(page, options, started, ok, blocked, errorText);

  try {
    const emailField = page.locator("#email");
    await emailField.waitFor({ state: "visible", timeout: 30_000 });
    await emailField.fill(options.email);
    // P7: PayPal also serves a newer login page (seen from Kernel's Linux
    // Chrome) whose buttons have no ids — match those by their text too.
    const next = page.locator("#btnNext").or(page.getByRole("button", { name: /^next$/i })).first();
    if (await next.isVisible().catch(() => false)) {
      await next.click();
    }

    const loginButton = page.locator("#btnLogin").or(page.getByRole("button", { name: /^log ?in$/i })).first();
    await loginButton.waitFor({ state: "visible", timeout: 20_000 });
    const passwordField = page.locator("#password");
    await passwordField.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(800);
    await passwordField.click();
    await passwordField.pressSequentially(options.password, { delay: 30 });
    await loginButton.click();

    // Either the review page's pay button shows up, or PayPal stops us
    // (bad credentials / rate limit banner, or a security challenge).
    const payButton = page
      .locator("#payment-submit-btn, #confirmButtonTop, [data-testid='submit-button-initial'], button:has-text('Continue'), button:has-text('Review Order'), button:has-text('Pay Now'), button:has-text('Complete Purchase')")
      .first();
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (await payButton.isVisible().catch(() => false)) {
        break;
      }
      if (await challengeVisible(page)) {
        return await finish(false, true, "PayPal showed a captcha / security challenge");
      }
      const banner = await errorBannerText(page);
      if (banner) {
        return await finish(false, false, banner);
      }
      await page.waitForTimeout(1_000);
    }
    if (!(await payButton.isVisible().catch(() => false))) {
      return await finish(false, false, "timed out waiting for PayPal's review page");
    }

    await page.waitForTimeout(1_000);

    if (options.returnUrlPrefix) {
      const prefix = options.returnUrlPrefix;
      // Wait for the browser to *request* the return URL (not for it to
      // load): PayPal has recorded the approval once it redirects there.
      const redirected = page.waitForRequest((request) => request.url().startsWith(prefix), { timeout: 45_000 });
      // Never an unhandled rejection if the click throws first and the browser closes.
      redirected.catch(() => undefined);
      try {
        await payButton.click();
        await redirected;
      } catch {
        if (await challengeVisible(page)) {
          return await finish(false, true, "PayPal showed a captcha / security challenge");
        }
        if (await genericErrorPage(page)) {
          return await finish(false, false, PAYPAL_GENERIC_ERROR);
        }
        return await finish(false, false, (await errorBannerText(page)) ?? "PayPal did not redirect to the return URL");
      }
    } else {
      await payButton.click();
      await page.waitForTimeout(4_000);
    }
    return await finish(true, false, null);
  } catch (err) {
    return await finish(false, false, err instanceof Error ? err.message.split("\n")[0]! : String(err));
  }
}
