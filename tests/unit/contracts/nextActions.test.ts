import { randomUUID } from "crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Envelope, NextAction } from "@/server/contracts/envelope";
import { findTool } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import "@/server/contracts/tools";
import type { Db } from "@/server/db/client";
import { createTestDb } from "@/server/db/testing";
import { simApprove } from "@/server/rail/simHandler";
import { getCaptureHandler } from "@/server/services/checkouts";

import { call, callRaw, createSimWorld, createTestAgent, type Data, fundPool } from "../../helpers/world";

/**
 * M9 (final review): every `next_actions` entry any tool emits must pass
 * its target tool's input schema as-is, so an agent that follows one
 * literally never gets INVALID_REQUEST. `human_approval` is a signal, not
 * a tool — its `then` continuation is validated instead.
 */

interface Emitted {
  from: string;
  action: NextAction;
}

function collect(from: string, envelope: Envelope<unknown>, into: Emitted[]): void {
  for (const action of envelope.next_actions) {
    if (action.tool === "human_approval") {
      const then = (action.args as { then?: NextAction }).then;
      expect(then, `${from}: human_approval without a then`).toBeTruthy();
      into.push({ from: `${from} (human_approval.then)`, action: then! });
    } else {
      into.push({ from, action });
    }
  }
}

function expectAllValid(emitted: Emitted[]): void {
  const failures: string[] = [];
  for (const { from, action } of emitted) {
    const target = findTool(action.tool);
    if (!target) {
      failures.push(`${from} → unknown tool ${action.tool}`);
      continue;
    }
    const parsed = target.input.safeParse(action.args);
    if (!parsed.success) {
      failures.push(`${from} → ${action.tool}(${JSON.stringify(action.args)}): ${parsed.error.message}`);
    }
  }
  expect(failures).toEqual([]);
}

describe("M9: every emitted next_action passes its target tool's input schema", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it("across the sample flows of every tool", async () => {
    const emitted: Emitted[] = [];
    const seenTools = new Set<string>();
    const record = (tool: string, result: { envelope: Envelope<unknown> }) => {
      seenTools.add(tool);
      collect(`${tool}:${result.envelope.status}`, result.envelope, emitted);
      return result;
    };
    const run = async (tool: string, key: string, input: Data) => record(tool, await call(db, tool, key, input));

    // Unauthenticated entry points (main world; neither calls PayPal).
    for (const [tool, input] of [
      ["get_bank_guide", {}],
      ["register_agent", { name: "Sample Agent", payout_email: "sample@example.com" }],
    ] as const) {
      record(tool, await runTool(findTool(tool), tool, input, { getDb: async () => db }));
    }

    const worldId = await createSimWorld(db);
    const fresh = await createTestAgent(db, worldId, "fresh@example.com");
    await run("get_status", fresh.key, {}); // no notes, no loan
    await run("check_eligibility", fresh.key, { amount_cents: 1000, term_days: 7 }); // no liquidity yet
    await run("apply_for_loan", fresh.key, { amount_cents: 60000, term_days: 7, purpose: "Too much money" }); // DECLINED

    // Lender: buy → awaiting approval → completed; status with notes; redeem.
    const lender = await createTestAgent(db, worldId, "lender@example.com");
    const buy = await run("buy_notes", lender.key, { amount_cents: 30000 });
    const checkoutId = (buy.envelope.data as Data).checkout_id as string;
    await run("confirm_checkout", lender.key, { checkout_id: checkoutId }); // not approved yet
    await simApprove(db, checkoutId);
    await run("confirm_checkout", lender.key, { checkout_id: checkoutId });
    await run("get_status", lender.key, {}); // has notes, no loan
    await run("redeem_notes", lender.key, { amount_cents: 1000 });
    await run("redeem_notes", lender.key, { amount_cents: 10_000_000 }); // insufficient

    // Borrower: eligible → offer → decline; offer → accept → loan, link, repay, statement.
    await fundPool(db, worldId, 20000, "lender2@example.com");
    const borrower = await createTestAgent(db, worldId, "borrower@example.com");
    await run("check_eligibility", borrower.key, { amount_cents: 10000, term_days: 14 });
    const declined = await run("apply_for_loan", borrower.key, { amount_cents: 10000, term_days: 14, purpose: "Working capital" });
    await run("decline_offer", borrower.key, { offer_id: (declined.envelope.data as Data).offer_id });
    const offer = await run("apply_for_loan", borrower.key, {
      amount_cents: 10000,
      term_days: 14,
      purpose: "Working capital",
      invoice: { client_email: "client@example.com", amount_cents: 20000, due_in_days: 14, description: "Work" },
    });
    const accepted = await run("accept_offer", borrower.key, {
      offer_id: (offer.envelope.data as Data).offer_id,
      disclosure_hash: (offer.envelope.data as Data).disclosure_hash,
    });
    const loanId = (accepted.envelope.data as Data).loan_id as string;
    await run("accept_offer", borrower.key, {
      offer_id: (offer.envelope.data as Data).offer_id,
      disclosure_hash: (offer.envelope.data as Data).disclosure_hash,
    }); // already accepted
    await run("get_status", borrower.key, {}); // open loan
    await run("get_loan", borrower.key, { loan_id: loanId });
    await run("get_loan", borrower.key, { loan_id: randomUUID() }); // not found
    const repay = await run("repay_loan", borrower.key, { loan_id: loanId });
    const repayCheckout = (repay.envelope.data as Data).checkout_id as string;
    await simApprove(db, repayCheckout);
    await run("confirm_checkout", borrower.key, { checkout_id: repayCheckout });
    await run("get_loan", borrower.key, { loan_id: loanId }); // repaid
    await run("get_statement", borrower.key, {});
    await run("confirm_checkout", borrower.key, { checkout_id: "UNKNOWN-ORDER" });

    // Every tool in the registry was exercised.
    for (const tool of ["get_bank_guide", "register_agent", "get_status", "check_eligibility", "apply_for_loan",
      "decline_offer", "accept_offer", "get_loan", "repay_loan", "buy_notes", "confirm_checkout", "redeem_notes",
      "get_statement"]) {
      expect(seenTools.has(tool), tool).toBe(true);
    }

    // Failed-checkout retry actions, including their fallbacks for a vanished source row.
    for (const purpose of ["note_purchase", "repayment_link", "repayment_direct"]) {
      const handler = getCaptureHandler(purpose);
      expect(handler, purpose).toBeTruthy();
      emitted.push({ from: `${purpose}.retryNextAction`, action: await handler!.retryNextAction(db, worldId, randomUUID()) });
    }

    expect(emitted.length).toBeGreaterThan(20);
    expectAllValid(emitted);
  });

  it("P3 final review I2/I5/C1: the newcomer path (no grade E → get_status loop), declaration retry, mandate_fee advice", async () => {
    const emitted: Emitted[] = [];
    const run = async (tool: string, key: string, input: Data, raw = false) => {
      const result = raw ? await callRaw(db, tool, key, input) : await call(db, tool, key, input);
      collect(`${tool}:${result.envelope.status}`, result.envelope, emitted);
      return result.envelope;
    };

    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const fresh = await createTestAgent(db, worldId, "newcomer@example.com", { credit: "real" });

    // get_status for a T1 agent with no history: the sample is the invoice-backed newcomer loan.
    const status = await run("get_status", fresh.key, {});
    expect(status.next_actions).toContainEqual({
      tool: "check_eligibility",
      args: { amount_cents: 1000, term_days: 7, invoice_amount_cents: 1500, collateral: "invoice_link" },
    });

    // Unsecured check → grade E → the invoice-backed check (amount capped at 5000, invoice ceil(1.5×)), never get_status.
    const unsecured = await run("check_eligibility", fresh.key, { amount_cents: 8001, term_days: 14 });
    expect(unsecured.reason_codes).toContain("insufficient_credit_history");
    expect(unsecured.next_actions).toEqual([
      {
        tool: "check_eligibility",
        args: { amount_cents: 5000, term_days: 14, invoice_amount_cents: 7500, collateral: "invoice_link" },
      },
    ]);
    const odd = await run("check_eligibility", fresh.key, { amount_cents: 1001, term_days: 7 });
    expect(odd.next_actions[0]!.args).toMatchObject({ amount_cents: 1001, invoice_amount_cents: 1502 });

    // Following it: eligible (grade D) → apply_for_loan carrying an invoice that covers principal + fee.
    const secured = await run("check_eligibility", fresh.key, unsecured.next_actions[0]!.args as Data);
    expect(secured.reason_codes).toEqual([]);
    const applyAction = secured.next_actions[0]!;
    expect(applyAction.tool).toBe("apply_for_loan");
    expect(applyAction.args).toMatchObject({
      amount_cents: 5000,
      term_days: 14,
      invoice: { amount_cents: 7500, due_in_days: 14 },
      declarations: { no_other_debt: true },
      attest: true,
    });

    // A declined unsecured application → the same invoice-backed check.
    const declined = await run("apply_for_loan", fresh.key, { amount_cents: 2000, term_days: 7, purpose: "Working capital" });
    expect(declined.status).toBe("DECLINED");
    expect(declined.next_actions).toEqual([
      {
        tool: "check_eligibility",
        args: { amount_cents: 2000, term_days: 7, invoice_amount_cents: 3000, collateral: "invoice_link" },
      },
    ]);

    // Only declaration_missing → the same application with E and H, and the summary says "only if true".
    const invoice = { client_email: "client@example.com", amount_cents: 1500, due_in_days: 7, description: "Work" };
    const undeclared = await run(
      "apply_for_loan",
      fresh.key,
      { amount_cents: 1000, term_days: 7, purpose: "Working capital", invoice },
      true,
    );
    expect(undeclared.reason_codes).toEqual(["declaration_missing"]);
    expect(undeclared.summary).toMatch(/ONLY if both are true/);
    expect(undeclared.next_actions).toEqual([
      {
        tool: "apply_for_loan",
        args: {
          amount_cents: 1000,
          term_days: 7,
          purpose: "Working capital",
          invoice,
          declarations: { no_other_debt: true },
          attest: true,
        },
      },
    ]);

    // mandate_fee at a 5% max fee: the advice quotes the mandate's max fee and the fee needed.
    const capped = await createTestAgent(db, worldId, "capped@example.com", { credit: "real", limits: { maxFeeBps: 500 } });
    const feeCheck = await run("check_eligibility", capped.key, {
      amount_cents: 1000,
      term_days: 7,
      invoice_amount_cents: 1500,
      collateral: "invoice_link",
    });
    expect(feeCheck.reason_codes).toEqual(["mandate_fee"]);
    expect(feeCheck.summary).toContain("max fee (currently 5%) to at least 5.8% (580 bps");
    const feeDecline = await run("apply_for_loan", capped.key, {
      amount_cents: 1000,
      term_days: 7,
      purpose: "Working capital",
      invoice,
    });
    expect(feeDecline.reason_codes).toEqual(["mandate_fee"]);
    const explanation = (feeDecline.data as Data).explanation as { next_steps: string[] };
    expect(explanation.next_steps[0]).toContain("max fee (currently 5%) to at least 5.8% (580 bps");

    expectAllValid(emitted);
  });
});
