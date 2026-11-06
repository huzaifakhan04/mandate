import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { createWriteStream, mkdirSync } from "fs";
import { join, resolve } from "path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { paypalConfig } from "@/server/paypal/config";
import { getAccessToken } from "@/server/paypal/token";

import { approvePayPalCheckout, type ApproveResult } from "../helpers/paypalApprove";

/**
 * Task 10 — the core loop end to end over REST against REAL PayPal
 * sandbox: a locally started `next dev` (in-memory PGlite: `DATABASE_URL`
 * forced empty, never Neon) with the real `PAYPAL_*` env, and real
 * sandbox personal accounts approving checkouts in headless Chromium
 * (tests/helpers/paypalApprove.ts).
 *
 * Skipped unless `PAYPAL_CLIENT_ID` is set AND `RUN_SANDBOX_E2E=1`, so
 * `npm test` stays offline. Run it with `npm run test:sandbox`.
 *
 * Webhooks can't reach localhost, so the test drives settlement the way
 * Vercel Cron would: `POST /api/cron/reconcile` with the CRON_SECRET it
 * generated for the server, in a polling loop.
 *
 * Accounts: the lender buys notes as PAYPAL_LENDER_EMAIL; the borrower's
 * payout receiver is the PAYPAL_OWNER account by PayPal payer ID (its
 * sandbox email is unconfirmed, so an EMAIL payout goes UNCLAIMED /
 * RECEIVER_UNCONFIRMED and is cancelled — see the Task 10 report); the
 * invoice is paid by PAYPAL_CLIENT_EMAIL, falling back to the OWNER
 * account if the client account's login is refused (it was rate-limited
 * during the day-1 spikes).
 */

const RUN = Boolean(process.env.PAYPAL_CLIENT_ID) && process.env.RUN_SANDBOX_E2E === "1";

const PORT = Number(process.env.SANDBOX_E2E_PORT ?? 3130);
const BASE = `http://localhost:${PORT}`;
const CRON_SECRET = randomBytes(24).toString("hex");
const ARTIFACTS = resolve("test-results/sandbox-e2e");

/** Expected numbers (cents): notes 3000; loan 1000 over 7 days; invoice 1500. */
const NOTES_CENTS = 3000;
const PRINCIPAL_CENTS = 1000;
const TERM_DAYS = 7;
const INVOICE_CENTS = 1500;
const FEE_CENTS = 15;
const REMAINDER_CENTS = INVOICE_CENTS - PRINCIPAL_CENTS - FEE_CENTS; // 485
const LENDER_EARNED_CENTS = 12; // floor(15 × 80 / 100)

const POLL_MS = 5_000;
const ACTIVE_WITHIN_MS = 120_000;
const REPAID_WITHIN_MS = 120_000;
const REMAINDER_PAID_WITHIN_MS = 180_000;

type Json = Record<string, unknown>;
interface Envelope {
  status: string;
  summary: string;
  data: Json;
  reason_codes?: string[];
  next_actions?: { tool: string; args: Json }[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

/** What the run observed, written to test-results/sandbox-e2e/summary-*.json (ids + timings, no secrets). */
const summary: Json = { started_at: new Date().toISOString(), timings_ms: {} as Record<string, number> };
const t0 = Date.now();
function mark(step: string): void {
  (summary.timings_ms as Record<string, number>)[step] = Date.now() - t0;
  console.log(`[sandbox-e2e] +${((Date.now() - t0) / 1000).toFixed(1)}s ${step}`);
}

async function tool(name: string, input: Json, apiKey?: string): Promise<{ http: number; body: Envelope }> {
  const res = await fetch(`${BASE}/api/v1/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(input),
  });
  return { http: res.status, body: (await res.json()) as Envelope };
}

/** A tool call that must succeed with HTTP 200. */
async function ok(name: string, input: Json, apiKey?: string): Promise<Envelope> {
  const { http, body } = await tool(name, input, apiKey);
  if (http !== 200) {
    throw new Error(`${name} → HTTP ${http}: ${JSON.stringify(body)}`);
  }
  return body;
}

const reconcileErrors: unknown[] = [];
async function reconcile(): Promise<void> {
  const res = await fetch(`${BASE}/api/cron/reconcile`, {
    method: "POST",
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  const body = (await res.json()) as { ok: boolean; report?: { errors?: unknown[] } };
  if (res.status !== 200 || !body.ok) {
    throw new Error(`reconcile → HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  if (body.report?.errors?.length) {
    reconcileErrors.push(...body.report.errors);
    console.warn(`[sandbox-e2e] reconcile reported errors: ${JSON.stringify(body.report.errors)}`);
  }
}

/** Calls reconcile, then `check`, every POLL_MS until `check` returns a value or `withinMs` passes. */
async function settleUntil<T>(what: string, withinMs: number, check: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    await reconcile();
    const value = await check();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${withinMs} ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

interface LedgerReport {
  trial_balance_cents: string;
  accounts: { code: string; owner_ref: string | null; balance_cents: string }[];
  operations: {
    total: number;
    failed: number;
    by_status: Record<string, number>;
    rows: { kind: string; purpose: string | null; status: string; paypal_id: string | null; attempts: number }[];
  };
}

async function ledgerReport(): Promise<LedgerReport> {
  const res = await fetch(`${BASE}/api/test/ledger`);
  if (res.status !== 200) {
    throw new Error(`/api/test/ledger → HTTP ${res.status}`);
  }
  return ((await res.json()) as { report: LedgerReport }).report;
}

function assertApproved(result: ApproveResult, who: string): void {
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

async function approve(url: string, account: "LENDER" | "OWNER" | "CLIENT", label: string): Promise<ApproveResult> {
  return approvePayPalCheckout(url, {
    email: requireEnv(`PAYPAL_${account}_EMAIL`),
    password: requireEnv(`PAYPAL_${account}_PASSWORD`),
    returnUrlPrefix: BASE,
    screenshotDir: ARTIFACTS,
    label,
  });
}

/**
 * The OWNER account's PayPal payer ID, for its payout receiver:
 * `PAYPAL_OWNER_PAYER_ID` if set, else discovered by having the owner
 * approve (never capture) a throwaway $1.00 order and reading
 * `payer.payer_id` off it. No money moves; the order just expires.
 */
async function ownerPayerId(): Promise<string> {
  if (process.env.PAYPAL_OWNER_PAYER_ID) {
    return process.env.PAYPAL_OWNER_PAYER_ID;
  }
  const { baseUrl } = paypalConfig();
  const headers = { Authorization: `Bearer ${await getAccessToken()}`, "Content-Type": "application/json" };
  const created = (await (
    await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: "1.00" }, description: "Mandate e2e: payer id lookup" }],
        payment_source: {
          paypal: { experience_context: { return_url: `${BASE}/sandbox-e2e/return`, cancel_url: `${BASE}/sandbox-e2e/cancel` } },
        },
      }),
    })
  ).json()) as { id: string; links: { rel: string; href: string }[] };
  const link = created.links.find((l) => l.rel === "payer-action" || l.rel === "approve");
  if (!link) {
    throw new Error("payer id lookup order has no approve link");
  }
  assertApproved(await approve(link.href, "OWNER", "owner-payer-id"), "OWNER");
  const order = (await (await fetch(`${baseUrl}/v2/checkout/orders/${created.id}`, { headers })).json()) as {
    payer?: { payer_id?: string };
  };
  const payerId = order.payer?.payer_id;
  if (!payerId) {
    throw new Error(`order ${created.id} has no payer.payer_id after approval`);
  }
  summary.payer_id_lookup_order_id = created.id;
  return payerId;
}

let server: ChildProcess | null = null;

describe.skipIf(!RUN)("core loop over REST against real PayPal sandbox", () => {
  beforeAll(async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    const log = createWriteStream(join(ARTIFACTS, `server-${Date.now()}.log`));
    // vitest sets NODE_ENV=test; let `next dev` choose its own.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_ENV"));
    const env: Record<string, string | undefined> = {
      ...inherited,
      // In-memory PGlite, never the Neon database `.env.local` points at.
      DATABASE_URL: "",
      PUBLIC_BASE_URL: BASE,
      CRON_SECRET,
      API_KEY_PEPPER: process.env.API_KEY_PEPPER || randomBytes(24).toString("hex"),
      MANDATE_TEST_ENDPOINTS: "1",
      PORT: String(PORT),
    };
    server = spawn(resolve("node_modules/.bin/next"), ["dev", "-p", String(PORT)], {
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.pipe(log);
    server.stderr?.pipe(log);

    const deadline = Date.now() + 180_000;
    for (;;) {
      if (server.exitCode !== null) {
        throw new Error(`next dev exited early (code ${server.exitCode}); see ${ARTIFACTS}`);
      }
      const ready = await fetch(`${BASE}/api/v1/get_bank_guide`)
        .then((res) => res.status === 200)
        .catch(() => false);
      if (ready) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error("next dev did not become ready within 180 s");
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    // The test-only ledger route must be live on this server.
    await ledgerReport();
    mark("server_ready");
  }, 240_000);

  afterAll(async () => {
    summary.finished_at = new Date().toISOString();
    summary.reconcile_errors = reconcileErrors;
    const file = join(ARTIFACTS, `summary-${Date.now()}.json`);
    await import("fs").then((fs) => fs.writeFileSync(file, JSON.stringify(summary, null, 2)));
    console.log(`[sandbox-e2e] summary: ${file}\n${JSON.stringify(summary, null, 2)}`);
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1_000));
      if (server.exitCode === null) {
        server.kill("SIGKILL");
      }
    }
  });

  it(
    "lender buys notes, borrower borrows against an invoice, the client pays the link with no agent online → REPAID, remainder paid, lender earns 12",
    async () => {
      // 1. Agents.
      const borrowerPayerId = await ownerPayerId();
      mark("owner_payer_id");
      const lender = await ok("register_agent", {
        name: "E2E Lender",
        model: "sandbox-e2e",
        payout_email: requireEnv("PAYPAL_LENDER_EMAIL"),
      });
      const lenderKey = lender.data.api_key as string;
      const borrower = await ok("register_agent", {
        name: "E2E Borrower",
        model: "sandbox-e2e",
        payout_paypal_id: borrowerPayerId,
      });
      const borrowerKey = borrower.data.api_key as string;
      summary.agents = { lender: lender.data.agent_id, borrower: borrower.data.agent_id };
      mark("agents_registered");

      // 2. buy_notes 3000 → the lender approves → confirm_checkout.
      const buy = await ok("buy_notes", { amount_cents: NOTES_CENTS }, lenderKey);
      expect(buy.status).toBe("AWAITING_APPROVAL");
      const notesOrderId = buy.data.checkout_id as string;
      summary.notes_order_id = notesOrderId;
      const lenderApproval = await approve(buy.data.approve_url as string, "LENDER", "notes");
      assertApproved(lenderApproval, "LENDER");
      summary.notes_approval_ms = lenderApproval.ms;
      mark("notes_approved");

      let confirm: Envelope | null = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        confirm = await ok("confirm_checkout", { checkout_id: notesOrderId }, lenderKey);
        if (confirm.status !== "PENDING" && confirm.status !== "AWAITING_APPROVAL") {
          break;
        }
        await new Promise((r) => setTimeout(r, 5_000));
      }
      expect(confirm?.status, JSON.stringify(confirm)).toBe("COMPLETED");
      mark("notes_confirmed");

      const lenderStatus = await ok("get_status", {}, lenderKey);
      expect((lenderStatus.data.balances as Json).notes_cents).toBe(NOTES_CENTS);

      // 3. The borrower applies for 1000 over 7 days with a 1500 invoice → accept.
      const apply = await ok(
        "apply_for_loan",
        {
          amount_cents: PRINCIPAL_CENTS,
          term_days: TERM_DAYS,
          purpose: "Sandbox e2e: working capital against an invoice",
          invoice: {
            client_email: requireEnv("PAYPAL_CLIENT_EMAIL"),
            amount_cents: INVOICE_CENTS,
            due_in_days: TERM_DAYS,
            description: "E2E-001",
          },
        },
        borrowerKey,
      );
      expect(apply.status, JSON.stringify(apply)).toBe("OFFERED");
      expect((apply.data.disclosure as Json).fee_cents).toBe(FEE_CENTS);

      const accept = await ok(
        "accept_offer",
        { offer_id: apply.data.offer_id, disclosure_hash: apply.data.disclosure_hash },
        borrowerKey,
      );
      expect(["DISBURSING", "ACTIVE"], JSON.stringify(accept)).toContain(accept.status);
      const loanId = accept.data.loan_id as string;
      summary.loan_id = loanId;
      mark(`offer_accepted_${accept.status.toLowerCase()}`);

      // 4. Reconcile until the disbursement payout settles → ACTIVE.
      const activeLoan = await settleUntil("loan ACTIVE with an open repayment link", ACTIVE_WITHIN_MS, async () => {
        const loan = await ok("get_loan", { loan_id: loanId }, borrowerKey);
        if (loan.data.status === "DISBURSEMENT_FAILED") {
          throw new Error(`disbursement failed: ${JSON.stringify(loan)}`);
        }
        const link = loan.data.repayment_link as Json | undefined;
        return loan.data.status === "ACTIVE" && typeof link?.url === "string" ? loan : null;
      });
      mark("loan_active");
      const link = activeLoan.data.repayment_link as Json;
      expect(link.amount_cents).toBe(INVOICE_CENTS);
      expect(link.status).toBe("OPEN");
      expect(activeLoan.data.outstanding_cents).toBe(PRINCIPAL_CENTS + FEE_CENTS);
      const linkAction = activeLoan.next_actions?.find((a) => a.tool === "human_approval");
      const invoiceOrderId = ((linkAction?.args.then as Json | undefined)?.args as Json | undefined)?.checkout_id;
      summary.invoice_order_id = invoiceOrderId;

      // 5. The client pays the link. No confirm_checkout (Review Focus 3):
      //    only the reconcile cron settles it.
      let payer: "CLIENT" | "OWNER" = "CLIENT";
      let clientApproval = await approve(link.url as string, "CLIENT", "invoice-client");
      if (!clientApproval.ok && !clientApproval.blocked) {
        console.warn(`[sandbox-e2e] CLIENT login refused (${clientApproval.errorText}); paying as OWNER instead`);
        summary.client_fallback_reason = clientApproval.errorText;
        payer = "OWNER";
        clientApproval = await approve(link.url as string, "OWNER", "invoice-owner");
      }
      assertApproved(clientApproval, payer);
      summary.invoice_payer = payer;
      summary.invoice_approval_ms = clientApproval.ms;
      mark("invoice_approved");

      await settleUntil("loan REPAID", REPAID_WITHIN_MS, async () => {
        const loan = await ok("get_loan", { loan_id: loanId }, borrowerKey);
        return loan.data.status === "REPAID" ? loan : null;
      });
      mark("loan_repaid");

      // 6a. The remainder payout (1500 − 1000 − 15 = 485) succeeds.
      const repaid = await settleUntil("remainder payout paid", REMAINDER_PAID_WITHIN_MS, async () => {
        const loan = await ok("get_loan", { loan_id: loanId }, borrowerKey);
        const history = loan.data.history as { type: string; payload: Json | null }[];
        if (history.some((e) => e.type === "loan.remainder_payout_failed")) {
          throw new Error(`remainder payout failed: ${JSON.stringify(history)}`);
        }
        return history.some((e) => e.type === "loan.remainder_paid") ? loan : null;
      });
      mark("remainder_paid");
      expect(repaid.data.outstanding_cents).toBe(0);
      const received = (repaid.data.history as { type: string; payload: Json | null }[]).find(
        (e) => e.type === "loan.repayment_received",
      );
      summary.repayment_received_payload = received?.payload ?? null;

      const borrowerStatus = await ok("get_status", {}, borrowerKey);
      expect((borrowerStatus.data.balances as Json).payable_to_you_cents).toBe(0);
      expect(borrowerStatus.data.open_loan).toBeNull();
      const borrowerStatement = await ok("get_statement", {}, borrowerKey);
      const borrowerLines = borrowerStatement.data.ledger_lines as { memo: string; account: string; amount_cents: number }[];
      // payable_to_borrower: +485 credited at capture, −485 when the payout settled.
      expect(borrowerLines.filter((l) => l.amount_cents === REMAINDER_CENTS)).toHaveLength(1);
      expect(borrowerLines.filter((l) => l.amount_cents === -REMAINDER_CENTS)).toHaveLength(1);

      // 6b. The lender earned 12 (80% of the 15 fee).
      const lenderStatement = await ok("get_statement", {}, lenderKey);
      expect((lenderStatement.data.notes as Json).earned_cents).toBe(LENDER_EARNED_CENTS);
      expect((lenderStatement.data.notes as Json).balance_cents).toBe(NOTES_CENTS + LENDER_EARNED_CENTS);

      // 6c/d. Trial balance 0; no failed_* paypal_operations.
      const report = await ledgerReport();
      summary.operations = report.operations.rows;
      summary.non_zero_accounts = report.accounts;
      expect(report.trial_balance_cents).toBe("0");
      // Task 10b: PayPal's fees are journaled (Dr paypal_fees_expense / Cr
      // cash_paypal), so cash = seed + the gross money flows less the fees — the
      // real PayPal balance movement. The captures always carry a fee.
      const balanceOf = (code: string) =>
        BigInt(report.accounts.find((a) => a.code === code && a.owner_ref === null)?.balance_cents ?? "0");
      const feesCents = balanceOf("paypal_fees_expense");
      summary.paypal_fees_cents = feesCents.toString();
      expect(feesCents > 0n).toBe(true);
      // Ruling W: plus the bank's seed capital (Cr bank_equity), whatever
      // BANK_SEED_CAPITAL_CENTS the server ran with.
      const seedCents = -balanceOf("bank_equity");
      summary.bank_seed_capital_cents = seedCents.toString();
      expect(balanceOf("cash_paypal") + feesCents - seedCents).toBe(
        BigInt(NOTES_CENTS + INVOICE_CENTS - PRINCIPAL_CENTS - REMAINDER_CENTS),
      );
      expect(report.operations.failed, JSON.stringify(report.operations.by_status)).toBe(0);
      const payouts = report.operations.rows.filter((r) => r.kind === "payout.send");
      expect(payouts.map((p) => [p.purpose, p.status])).toEqual([
        ["loan_disbursement", "succeeded"],
        ["remainder_payout", "succeeded"],
      ]);
      summary.payout_batch_ids = Object.fromEntries(payouts.map((p) => [p.purpose, p.paypal_id]));
      expect(report.operations.rows.filter((r) => r.kind === "payout.cancel_item")).toEqual([]);
      mark("asserted");
    },
    10 * 60_000,
  );
});
