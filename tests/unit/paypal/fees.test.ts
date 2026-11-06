import { randomUUID } from "crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/client";
import { worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import {
  buildCaptureOrderRequest,
  buildCreateOrderRequest,
  buildGetOrderRequest,
  buildGetPayoutRequest,
  buildSendPayoutRequest,
  enqueueOperation,
  enqueueReadOperation,
  executeOperation,
  successBody,
} from "@/server/paypal/operations";
import { parseCaptureOrderResponse, parseGetOrderResponse } from "@/server/paypal/orders";
import { parseGetPayoutResponse, parseSendPayoutResponse } from "@/server/paypal/payouts";
import { simApprove, simCaptureFeeCents, simClaimPayoutItem } from "@/server/rail/simHandler";

/** Task 10b: PayPal's processing fees are parsed into the stored results (and simulated on the sim rail). */

const CAPTURED_ORDER = {
  id: "ORDER-1",
  status: "COMPLETED",
  purchase_units: [
    {
      payments: {
        captures: [
          {
            id: "CAP-1",
            status: "COMPLETED",
            amount: { currency_code: "USD", value: "300.00" },
            seller_receivable_breakdown: {
              gross_amount: { currency_code: "USD", value: "300.00" },
              paypal_fee: { currency_code: "USD", value: "9.00" },
              net_amount: { currency_code: "USD", value: "291.00" },
            },
          },
        ],
      },
    },
  ],
};

describe("fee parsing", () => {
  it("capture: seller_receivable_breakdown → paypalFeeCents / grossCents / netCents (strings)", () => {
    expect(parseCaptureOrderResponse("ORDER-1", CAPTURED_ORDER)).toMatchObject({
      captureId: "CAP-1",
      amountCents: "30000",
      paypalFeeCents: "900",
      grossCents: "30000",
      netCents: "29100",
    });
    expect(parseGetOrderResponse(CAPTURED_ORDER).capture).toMatchObject({ paypalFeeCents: "900", netCents: "29100" });
  });

  it("capture without a breakdown (e.g. still PENDING) → fee fields null", () => {
    const body = structuredClone(CAPTURED_ORDER);
    delete (body.purchase_units[0]!.payments.captures[0] as Record<string, unknown>).seller_receivable_breakdown;
    expect(parseCaptureOrderResponse("ORDER-1", body)).toMatchObject({
      paypalFeeCents: null,
      grossCents: null,
      netCents: null,
    });
  });

  it("payout: batch_header.fees.value → feeCents; absent → null", () => {
    const body = {
      batch_header: { payout_batch_id: "B-1", batch_status: "SUCCESS", fees: { currency: "USD", value: "0.25" } },
      items: [{ payout_item_id: "I-1", transaction_status: "SUCCESS" }],
    };
    expect(parseGetPayoutResponse(body)).toMatchObject({ batchId: "B-1", feeCents: "25" });
    expect(parseSendPayoutResponse(body)).toMatchObject({ batchId: "B-1", feeCents: "25" });
    expect(
      parseGetPayoutResponse({ batch_header: { payout_batch_id: "B-2", batch_status: "PENDING" } }),
    ).toMatchObject({ feeCents: null });
  });
});

describe("sim rail fees (simulated: 2.9% + 30¢ per capture, 25¢ per SUCCESS payout item)", () => {
  let db: Db;
  let worldId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    const [world] = await db
      .insert(worlds)
      .values({ slug: `world-${randomUUID()}`, name: "World", railMode: "sim" })
      .returning();
    worldId = world!.id;
  });

  it("simCaptureFeeCents rounds 2.9% half-up and adds 30¢", () => {
    expect(simCaptureFeeCents(30000n)).toBe(900n);
    expect(simCaptureFeeCents(1500n)).toBe(74n); // 43.5 → 44, + 30
    expect(simCaptureFeeCents(1000n)).toBe(59n); // 29 + 30
    expect(simCaptureFeeCents(10n)).toBe(10n); // never more than the gross
  });

  it("a sim capture (and a later order.get) reports the fee breakdown", async () => {
    const { operationId: createId } = await enqueueOperation(db, {
      worldId,
      rail: "sim",
      kind: "order.create",
      purpose: "note_purchase",
      sourceId: randomUUID(),
      request: buildCreateOrderRequest({
        amountCents: 1500n,
        description: "x",
        customId: "c",
        returnUrl: "https://e.com/r",
        cancelUrl: "https://e.com/c",
      }),
    });
    const orderId = successBody(await executeOperation(db, createId), "order.create").orderId;
    await simApprove(db, orderId);
    const { operationId: captureId } = await enqueueOperation(db, {
      worldId,
      rail: "sim",
      kind: "order.capture",
      purpose: "note_purchase_capture",
      sourceId: orderId,
      request: buildCaptureOrderRequest(orderId),
    });
    const captured = successBody(await executeOperation(db, captureId), "order.capture");
    expect(captured).toMatchObject({ amountCents: "1500", paypalFeeCents: "74", grossCents: "1500", netCents: "1426" });

    const { operationId: readId } = await enqueueReadOperation(db, {
      worldId,
      rail: "sim",
      kind: "order.get",
      request: buildGetOrderRequest(orderId),
    });
    expect(successBody(await executeOperation(db, readId), "order.get").capture).toMatchObject({ paypalFeeCents: "74" });
  });

  async function send(receiver: string) {
    const { operationId } = await enqueueOperation(db, {
      worldId,
      rail: "sim",
      kind: "payout.send",
      purpose: "note_redemption",
      sourceId: randomUUID(),
      request: buildSendPayoutRequest({ receiver, receiverType: "EMAIL", amountCents: 1000n, senderItemId: "s" }),
    });
    return successBody(await executeOperation(db, operationId), "payout.send");
  }

  async function get(batchId: string) {
    const { operationId } = await enqueueReadOperation(db, {
      worldId,
      rail: "sim",
      kind: "payout.get",
      request: buildGetPayoutRequest(batchId),
    });
    return successBody(await executeOperation(db, operationId), "payout.get");
  }

  it("a SUCCESS payout item costs 25¢ (send and get); a FAILED one costs nothing", async () => {
    const ok = await send("someone@example.com");
    expect(ok.feeCents).toBe("25");
    expect((await get(ok.batchId)).feeCents).toBe("25");

    const failed = await send("fail@example.com");
    expect(failed.feeCents).toBe("0");
  });

  it("live-shaped (pending) send has no fee; the later get shows it", async () => {
    const pending = await send("pending@example.com");
    expect(pending.feeCents).toBeNull();
    expect((await get(pending.batchId)).feeCents).toBe("25");
  });

  it("an UNCLAIMED item costs nothing until it is claimed", async () => {
    const unclaimed = await send("unclaimed@example.com");
    expect(unclaimed.feeCents).toBe("0");
    await simClaimPayoutItem(db, unclaimed.item!.itemId!);
    expect((await get(unclaimed.batchId)).feeCents).toBe("25");
  });
});
