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

import { call, createSimWorld, createTestAgent, type Data, fundPool } from "../../helpers/world";

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
});
