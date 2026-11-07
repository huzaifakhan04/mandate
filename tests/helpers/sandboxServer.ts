import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { copyFileSync, createWriteStream, mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { paypalConfig } from "@/server/paypal/config";
import { getAccessToken } from "@/server/paypal/token";

import { approvePayPalCheckout, type ApproveResult, PAYPAL_GENERIC_ERROR } from "./paypalApprove";

/**
 * Shared by the real-sandbox tests (Task 10's core-loop e2e and Task 11's
 * agent acceptance harness): start a local `next dev` on in-memory PGlite
 * with the real `PAYPAL_*` env, drive the reconcile cron (no webhooks reach
 * localhost), read the env-gated `/api/test/ledger` report, and approve
 * PayPal checkouts as one of the sandbox personal accounts.
 *
 * Secrets: CRON_SECRET / API_KEY_PEPPER are generated per server and never
 * printed; sandbox passwords are only typed into PayPal's login form.
 */

export type SandboxAccount = "LENDER" | "OWNER" | "CLIENT";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export interface LocalServer {
  base: string;
  cronSecret: string;
  logPath: string;
  stop(): Promise<void>;
}

/**
 * Spawns `next dev -p <port>` with `DATABASE_URL` forced empty (in-memory
 * PGlite, never the Neon database `.env.local` points at), a fresh
 * CRON_SECRET, the test-only endpoints on, and waits until it serves both
 * `get_bank_guide` and `/api/test/ledger`. A fresh SESSION_SECRET too, unless
 * one is set. The server log goes to
 * `<artifactsDir>/server-<ts>.log`.
 */
export async function startLocalServer(options: { port: number; artifactsDir: string }): Promise<LocalServer> {
  const { port, artifactsDir } = options;
  const base = `http://localhost:${port}`;
  const cronSecret = randomBytes(24).toString("hex");
  mkdirSync(artifactsDir, { recursive: true });
  // The live log is written OUTSIDE the project: `next dev` watches the
  // project tree, and a log file growing inside it makes every write a
  // change → recompile → HMR full reload of any page a browser has open
  // (a reload loop on the claim page). It is copied to `artifactsDir` on stop.
  const liveLogPath = join(mkdtempSync(join(tmpdir(), "mandate-next-")), "server.log");
  const logPath = join(artifactsDir, `server-${Date.now()}.log`);
  const log = createWriteStream(liveLogPath);
  // vitest sets NODE_ENV=test; let `next dev` choose its own.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_ENV"));
  const env: Record<string, string | undefined> = {
    ...inherited,
    DATABASE_URL: "",
    PUBLIC_BASE_URL: base,
    CRON_SECRET: cronSecret,
    API_KEY_PEPPER: process.env.API_KEY_PEPPER || randomBytes(24).toString("hex"),
    // P2: the owner session cookie (Verify with PayPal → claim → mandate) is HMAC-signed with this.
    SESSION_SECRET: process.env.SESSION_SECRET || randomBytes(32).toString("hex"),
    MANDATE_TEST_ENDPOINTS: "1",
    PORT: String(port),
  };
  const server: ChildProcess = spawn(resolve("node_modules/.bin/next"), ["dev", "-p", String(port)], {
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.pipe(log);
  server.stderr?.pipe(log);

  async function stop(): Promise<void> {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1_000));
      if (server.exitCode === null) {
        server.kill("SIGKILL");
      }
    }
    try {
      copyFileSync(liveLogPath, logPath);
    } catch {
      // best effort
    }
  }

  const deadline = Date.now() + 180_000;
  for (;;) {
    if (server.exitCode !== null) {
      copyFileSync(liveLogPath, logPath);
      throw new Error(`next dev exited early (code ${server.exitCode}); see ${logPath}`);
    }
    const ready = await fetch(`${base}/api/v1/get_bank_guide`)
      .then((res) => res.status === 200)
      .catch(() => false);
    if (ready) {
      break;
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error("next dev did not become ready within 180 s");
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  // The test-only ledger route must be live on this server.
  await ledgerReport(base);
  return { base, cronSecret, logPath, stop };
}

/** `POST /api/cron/reconcile` the way the Render cron job does; returns the errors the report listed (if any). */
export async function reconcile(base: string, cronSecret: string): Promise<unknown[]> {
  const res = await fetch(`${base}/api/cron/reconcile`, {
    method: "POST",
    headers: { authorization: `Bearer ${cronSecret}` },
  });
  const body = (await res.json()) as { ok: boolean; report?: { errors?: unknown[] } };
  if (res.status !== 200 || !body.ok) {
    throw new Error(`reconcile → HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return body.report?.errors ?? [];
}

export interface LedgerReport {
  trial_balance_cents: string;
  accounts: { code: string; owner_ref: string | null; balance_cents: string }[];
  operations: {
    total: number;
    failed: number;
    by_status: Record<string, number>;
    rows: { kind: string; purpose: string | null; status: string; paypal_id: string | null; attempts: number }[];
  };
}

/** The env-gated `/api/test/ledger` report (only served with MANDATE_TEST_ENDPOINTS=1). */
export async function ledgerReport(base: string): Promise<LedgerReport> {
  const res = await fetch(`${base}/api/test/ledger`);
  if (res.status !== 200) {
    throw new Error(`/api/test/ledger → HTTP ${res.status}`);
  }
  return ((await res.json()) as { report: LedgerReport }).report;
}

/**
 * TEST-ONLY claim + mandate (`POST /api/test/claim`, served only with
 * MANDATE_TEST_ENDPOINTS=1): lifts a main-world agent to KYA tier 1 so it
 * can borrow without a human in a browser. Task 7 replaces this with the
 * real claim page + mandate flow driven by Playwright.
 */
export async function testClaim(base: string, agentId: string): Promise<void> {
  const res = await fetch(`${base}/api/test/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: agentId }),
  });
  if (res.status !== 200) {
    throw new Error(`/api/test/claim → HTTP ${res.status}`);
  }
}

export function assertApproved(result: ApproveResult, who: string): void {
  if (result.blocked) {
    throw new Error(
      `BLOCKED: PayPal showed a security challenge to the ${who} account (screenshot: ${result.screenshotPath}). ` +
        "Not attempting to bypass it.",
    );
  }
  if (!result.ok) {
    throw new Error(`${who} approval failed: ${result.errorText} (screenshot: ${result.screenshotPath})`);
  }
}

/**
 * P7: where PayPal checkout approvals run — a local Playwright Chromium
 * (default) or a Kernel cloud browser (tests/helpers/kernelApprove.ts). The
 * acceptance harness sets it from `--browser`.
 */
export type ApprovalBrowser = "local" | "kernel";
let approvalBrowser: ApprovalBrowser = process.env.APPROVAL_BROWSER === "kernel" ? "kernel" : "local";
export function setApprovalBrowser(browser: ApprovalBrowser): void {
  approvalBrowser = browser;
}

/** Pause before retrying after PayPal sandbox's transient error page. */
export const PAYPAL_RETRY_PAUSE_MS = 20_000;

/**
 * Approves a PayPal checkout URL as `PAYPAL_<account>_EMAIL` / `_PASSWORD`.
 * PayPal sandbox's transient "things don't appear to be working" page gets
 * one retry after a pause (the order is still awaiting approval); a
 * captcha / challenge is never retried.
 */
export async function approveAs(
  url: string,
  account: SandboxAccount,
  options: { returnUrlPrefix: string; screenshotDir: string; label: string; browser?: ApprovalBrowser },
): Promise<ApproveResult> {
  const approveFn =
    (options.browser ?? approvalBrowser) === "kernel"
      ? (await import("./kernelApprove")).approvePayPalCheckoutViaKernel
      : approvePayPalCheckout;
  const attempt = (label: string) =>
    approveFn(url, {
      email: requireEnv(`PAYPAL_${account}_EMAIL`),
      password: requireEnv(`PAYPAL_${account}_PASSWORD`),
      returnUrlPrefix: options.returnUrlPrefix,
      screenshotDir: options.screenshotDir,
      label,
    });
  const first = await attempt(options.label);
  if (first.ok || first.blocked || first.errorText !== PAYPAL_GENERIC_ERROR) {
    return first;
  }
  console.warn(`[paypal] ${account} approval hit PayPal's transient error page; retrying once in ${PAYPAL_RETRY_PAUSE_MS / 1000}s`);
  await new Promise((r) => setTimeout(r, PAYPAL_RETRY_PAUSE_MS));
  return attempt(`${options.label}-retry`);
}

/**
 * A sandbox account's PayPal payer ID, for a payout receiver (sandbox
 * emails are unconfirmed, so EMAIL payouts go UNCLAIMED):
 * `PAYPAL_<account>_PAYER_ID` if set, else discovered by having the
 * account approve (never capture) a throwaway $1.00 order and reading
 * `payer.payer_id` off it. No money moves; the order just expires.
 */
export async function payerIdFor(
  account: SandboxAccount,
  options: { returnUrl: string; screenshotDir: string },
): Promise<{ payerId: string; lookupOrderId: string | null }> {
  const preset = process.env[`PAYPAL_${account}_PAYER_ID`];
  if (preset) {
    return { payerId: preset, lookupOrderId: null };
  }
  const { baseUrl } = paypalConfig();
  const headers = { Authorization: `Bearer ${await getAccessToken()}`, "Content-Type": "application/json" };
  const created = (await (
    await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: "1.00" }, description: "Mandate test: payer id lookup" }],
        payment_source: {
          paypal: { experience_context: { return_url: options.returnUrl, cancel_url: `${options.returnUrl}/cancel` } },
        },
      }),
    })
  ).json()) as { id: string; links: { rel: string; href: string }[] };
  const link = created.links.find((l) => l.rel === "payer-action" || l.rel === "approve");
  if (!link) {
    throw new Error("payer id lookup order has no approve link");
  }
  const approved = await approveAs(link.href, account, {
    returnUrlPrefix: options.returnUrl,
    screenshotDir: options.screenshotDir,
    label: `${account.toLowerCase()}-payer-id`,
  });
  assertApproved(approved, account);
  const order = (await (await fetch(`${baseUrl}/v2/checkout/orders/${created.id}`, { headers })).json()) as {
    payer?: { payer_id?: string };
  };
  const payerId = order.payer?.payer_id;
  if (!payerId) {
    throw new Error(`order ${created.id} has no payer.payer_id after approval`);
  }
  return { payerId, lookupOrderId: created.id };
}
