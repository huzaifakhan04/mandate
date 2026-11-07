import { chromium, type Browser, type Page } from "@playwright/test";

import { approveOnPage, approvalFailure, type ApproveOptions, type ApproveResult } from "./paypalApprove";

/**
 * P7 (Kernel sponsor) — approves a PayPal *sandbox* checkout from a Kernel
 * cloud browser instead of a local Chromium: create a browser session
 * (POST https://api.onkernel.com/browsers), connect Playwright over CDP,
 * run the exact same page logic as `paypalApprove.ts` (`approveOnPage`),
 * then always delete the session (DELETE /browsers/{session_id}).
 *
 * Test/harness-only: the bank never automates a human approval of a real
 * PayPal page server-side — this is for the sandbox acceptance harness
 * (`--browser kernel`) and an operator approving their own sandbox
 * checkout when no human is handy.
 *
 * No bot-check circumvention: `stealth` (Kernel's stealth mode + CAPTCHA
 * solver) is deliberately left off, and a captcha/security challenge
 * stops the approval (`blocked: true`) exactly as the local helper does.
 * KERNEL_API_KEY is read from the environment and never logged.
 */

const KERNEL_API = "https://api.onkernel.com";

export interface KernelSession {
  session_id: string;
  cdp_ws_url: string;
  browser_live_view_url?: string;
}

function kernelKey(): string {
  const key = process.env.KERNEL_API_KEY;
  if (!key) {
    throw new Error("KERNEL_API_KEY is not set (run with --env-file=.env.local)");
  }
  return key;
}

export async function createKernelBrowser(options: { headless?: boolean; timeoutSeconds?: number; name?: string } = {}): Promise<KernelSession> {
  const res = await fetch(`${KERNEL_API}/browsers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${kernelKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      headless: options.headless ?? true,
      stealth: false,
      timeout_seconds: options.timeoutSeconds ?? 300,
      ...(options.name ? { name: options.name } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Kernel POST /browsers → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as KernelSession;
}

export async function deleteKernelBrowser(sessionId: string): Promise<void> {
  const res = await fetch(`${KERNEL_API}/browsers/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${kernelKey()}` },
  });
  if (!res.ok && res.status !== 404) {
    console.warn(`[kernel] DELETE /browsers/${sessionId} → HTTP ${res.status}`);
  }
}

/**
 * Runs `fn` with a page in a fresh Kernel browser; the session is deleted
 * afterwards whatever happens.
 */
export async function withKernelPage<T>(fn: (page: Page, session: KernelSession) => Promise<T>, options: { headless?: boolean } = {}): Promise<T> {
  const session = await createKernelBrowser({ headless: options.headless, name: `mandate-approve-${Date.now()}` });
  let browser: Browser | null = null;
  try {
    browser = await chromium.connectOverCDP(session.cdp_ws_url, { timeout: 60_000 });
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    // Kernel's default window is small enough that PayPal's sticky footer
    // overlaps the login form's "Next" button (clicks time out): use a
    // desktop-sized viewport, as a local Chromium has.
    await page.setViewportSize({ width: 1280, height: 900 });
    return await fn(page, session);
  } finally {
    await browser?.close().catch(() => undefined);
    await deleteKernelBrowser(session.session_id);
  }
}

/** Same contract as `approvePayPalCheckout`, but in a Kernel cloud browser. */
export async function approvePayPalCheckoutViaKernel(approveUrl: string, options: ApproveOptions): Promise<ApproveResult> {
  const started = Date.now();
  return withKernelPage(
    async (page) => {
      try {
        await page.goto(approveUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      } catch (err) {
        return approvalFailure(page, options, started, err instanceof Error ? err.message.split("\n")[0]! : String(err));
      }
      return approveOnPage(page, options, started);
    },
    { headless: options.headless },
  );
}
