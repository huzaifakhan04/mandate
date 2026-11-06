import { randomUUID } from "crypto";

import { and, eq, isNull } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/client";
import { paypalOperations, repayments, webhookEvents } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { createPayPalWebhookHandler } from "@/server/jobs/webhookHandler";
import { runReconcile } from "@/server/jobs/reconcile";
import { __resetTokenCacheForTests } from "@/server/paypal/token";
import { simApprove, simSetCaptureStatus } from "@/server/rail/simHandler";
import { pollPayoutStatus } from "@/server/services/payoutPolling";

import {
  borrow,
  createSimWorld,
  fundPool,
  getLoan,
  invoiceLink,
  journalsWithKeyPrefix,
  later,
  type Data,
} from "../jobs/fixtures";

const BASE_URL = "https://api-m.paypal.test";
const server = setupServer();

let verifyCalls = 0;
let verifyBodies: Data[] = [];
let verificationStatus: "SUCCESS" | "FAILURE" | "HTTP_500" = "SUCCESS";

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const TRANSMISSION_HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-transmission-id": "tx-1",
  "paypal-transmission-sig": "sig==",
  "paypal-transmission-time": "2026-11-06T10:00:00Z",
};

function webhookRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/webhooks/paypal", {
    method: "POST",
    headers: { "content-type": "application/json", ...TRANSMISSION_HEADERS, ...headers },
    body,
  });
}

function event(type: string, resource: Data, id = `WH-${randomUUID()}`) {
  return { id, event_type: type, resource_type: "x", resource, create_time: "2026-11-06T10:00:00Z" };
}

async function payoutBatchId(db: Db, sendOpId: string) {
  const [send] = await db.select().from(paypalOperations).where(eq(paypalOperations.id, sendOpId));
  return send!.paypalId!;
}

async function storedEvent(db: Db, paypalEventId: string) {
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.paypalEventId, paypalEventId));
  return row;
}

describe("PayPal webhooks (verified)", () => {
  let db: Db;
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    process.env.PAYPAL_BASE_URL = BASE_URL;
    process.env.PAYPAL_CLIENT_ID = "test-client-id";
    process.env.PAYPAL_CLIENT_SECRET = "test-client-secret";
    process.env.PAYPAL_WEBHOOK_ID = "WEBHOOK-ID-1";
    __resetTokenCacheForTests();
    verifyCalls = 0;
    verifyBodies = [];
    verificationStatus = "SUCCESS";
    server.use(
      http.post(`${BASE_URL}/v1/oauth2/token`, () => HttpResponse.json({ access_token: "tok", expires_in: 32400 })),
      http.post(`${BASE_URL}/v1/notifications/verify-webhook-signature`, async ({ request }) => {
        verifyCalls += 1;
        verifyBodies.push((await request.json()) as Data);
        if (verificationStatus === "HTTP_500") {
          return HttpResponse.json({ name: "INTERNAL_SERVICE_ERROR" }, { status: 500 });
        }
        return HttpResponse.json({ verification_status: verificationStatus });
      }),
    );
    db = await createTestDb();
    POST = createPayPalWebhookHandler({ getDb: async () => db }).POST;
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
    delete process.env.PAYPAL_BASE_URL;
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.PAYPAL_WEBHOOK_ID;
  });

  async function disbursingLoan() {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId, { receiver: "pending-borrower@example.com" });
    expect((await getLoan(db, borrower.loanId)).status).toBe("disbursing");
    const batchId = await payoutBatchId(db, borrower.sendOpId);
    return { worldId, ...borrower, batchId };
  }

  function payoutSucceeded(batchId: string, id?: string) {
    return event(
      "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      { payout_batch_id: batchId, payout_item_id: "ITEM-1", transaction_status: "SUCCESS" },
      id,
    );
  }

  it("sends the transmission headers, webhook id and event to PayPal's verify endpoint", async () => {
    const evt = event("SOMETHING.ELSE", { id: "nothing" });
    const res = await POST(webhookRequest(JSON.stringify(evt)));
    expect(res.status).toBe(200);
    expect(verifyCalls).toBe(1);
    expect(verifyBodies[0]).toEqual({
      auth_algo: "SHA256withRSA",
      cert_url: TRANSMISSION_HEADERS["paypal-cert-url"],
      transmission_id: "tx-1",
      transmission_sig: "sig==",
      transmission_time: "2026-11-06T10:00:00Z",
      webhook_id: "WEBHOOK-ID-1",
      webhook_event: evt,
    });
  });

  it("an unverified webhook → 400, stored verified=false, no effect", async () => {
    const { worldId, loanId, batchId } = await disbursingLoan();
    verificationStatus = "FAILURE";
    const evt = payoutSucceeded(batchId);

    const res = await POST(webhookRequest(JSON.stringify(evt)));
    expect(res.status).toBe(400);
    const row = await storedEvent(db, evt.id);
    expect(row?.verified).toBe(false);
    expect(row?.processedAt).toBeNull();
    // M4: an unverified (attacker-controllable) body is never stored — only its ids.
    expect(row?.payload).toEqual({ event_type: evt.event_type, paypal_event_id: evt.id, verified: false });
    expect((await getLoan(db, loanId)).status).toBe("disbursing");
    expect(await journalsWithKeyPrefix(db, worldId, "loan_disbursement:")).toHaveLength(0);
  });

  it("missing transmission headers → 400 unverified without calling PayPal", async () => {
    const evt = event("SOMETHING.ELSE", { id: "x" });
    const res = await POST(
      new Request("http://localhost/api/webhooks/paypal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(evt),
      }),
    );
    expect(res.status).toBe(400);
    expect(verifyCalls).toBe(0);
    expect((await storedEvent(db, evt.id))?.verified).toBe(false);
  });

  it("a later verified delivery of an id first stored unverified is processed", async () => {
    const { loanId, batchId } = await disbursingLoan();
    const evt = payoutSucceeded(batchId);
    verificationStatus = "FAILURE";
    expect((await POST(webhookRequest(JSON.stringify(evt)))).status).toBe(400);
    verificationStatus = "SUCCESS";
    expect((await POST(webhookRequest(JSON.stringify(evt)))).status).toBe(200);
    expect((await getLoan(db, loanId)).status).toBe("active");
    const upgraded = await storedEvent(db, evt.id);
    expect(upgraded?.verified).toBe(true);
    expect(upgraded?.payload).toMatchObject({ id: evt.id, event_type: evt.event_type }); // the verified body replaces the stub
  });

  it("M4: a verified payload is stored redacted (emails masked, token-like keys removed)", async () => {
    const evt = event("SOMETHING.ELSE", {
      id: "nothing",
      payer: { email_address: "client.person@example.com" },
      access_token: "should-not-be-stored",
    });
    expect((await POST(webhookRequest(JSON.stringify(evt)))).status).toBe(200);
    const row = await storedEvent(db, evt.id);
    expect(row?.verified).toBe(true);
    const stored = JSON.stringify(row?.payload);
    expect(stored).not.toContain("client.person@example.com");
    expect(stored).not.toContain("should-not-be-stored");
    expect(row?.payload).toMatchObject({
      id: evt.id,
      resource: { payer: { email_address: "cl***********@example.com" }, access_token: "[REDACTED]" },
    });
  });

  it("the verify call failing (PayPal 5xx) → 503 so PayPal retries; nothing applied", async () => {
    const { loanId, batchId } = await disbursingLoan();
    verificationStatus = "HTTP_500";
    const evt = payoutSucceeded(batchId);
    const res = await POST(webhookRequest(JSON.stringify(evt)));
    expect(res.status).toBe(503);
    expect((await getLoan(db, loanId)).status).toBe("disbursing");
  });

  it("the same event id twice → one effect (second is a 200 no-op)", async () => {
    const { worldId, loanId, batchId } = await disbursingLoan();
    const evt = payoutSucceeded(batchId);

    const first = await POST(webhookRequest(JSON.stringify(evt)));
    expect(first.status).toBe(200);
    expect((await getLoan(db, loanId)).status).toBe("active");
    const row = await storedEvent(db, evt.id);
    expect(row).toMatchObject({ verified: true, worldId, type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED" });
    expect(row?.processedAt).toBeInstanceOf(Date);

    const second = await POST(webhookRequest(JSON.stringify(evt)));
    expect(second.status).toBe(200);
    expect(((await second.json()) as Data).duplicate).toBe(true);
    expect(await journalsWithKeyPrefix(db, worldId, "loan_disbursement:")).toHaveLength(1);
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
  });

  it("Review Focus 2: webhook payout success then a cron poll of the same → one journal", async () => {
    const { worldId, loanId, sendOpId, batchId } = await disbursingLoan();
    expect((await POST(webhookRequest(JSON.stringify(payoutSucceeded(batchId))))).status).toBe(200);
    expect((await getLoan(db, loanId)).status).toBe("active");

    await runReconcile(db, { now: later() });
    expect(await pollPayoutStatus(db, sendOpId, { now: later(5 * 60_000) })).toEqual({
      polled: false,
      reason: "source_settled",
    });
    expect(await journalsWithKeyPrefix(db, worldId, "loan_disbursement:")).toHaveLength(1);
    // The webhook-activated loan's invoice link create was executed too.
    expect((await invoiceLink(db, loanId))?.status).toBe("open");
  });

  it("Review Focus 2 (reverse order): cron poll first, then the webhook → one journal", async () => {
    const { worldId, loanId, batchId } = await disbursingLoan();
    await runReconcile(db, { now: later() });
    expect((await getLoan(db, loanId)).status).toBe("active");
    expect((await POST(webhookRequest(JSON.stringify(payoutSucceeded(batchId))))).status).toBe(200);
    expect(await journalsWithKeyPrefix(db, worldId, "loan_disbursement:")).toHaveLength(1);
  });

  it("CHECKOUT.ORDER.APPROVED for an invoice link → captured, waterfall applied once; a CAPTURE.COMPLETED after it changes nothing", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const link = await invoiceLink(db, borrower.loanId);
    const orderId = link!.paypalOrderId!;
    await simApprove(db, orderId);

    const approved = await POST(webhookRequest(JSON.stringify(event("CHECKOUT.ORDER.APPROVED", { id: orderId, status: "APPROVED" }))));
    expect(approved.status).toBe(200);
    expect((await getLoan(db, borrower.loanId)).status).toBe("repaid");
    const [repayment] = await db.select().from(repayments).where(eq(repayments.loanId, borrower.loanId));
    expect(repayment?.remainderStatus).toBe("paid");

    const completed = event("PAYMENT.CAPTURE.COMPLETED", {
      id: repayment!.captureId,
      status: "COMPLETED",
      supplementary_data: { related_ids: { order_id: orderId } },
    });
    expect((await POST(webhookRequest(JSON.stringify(completed)))).status).toBe(200);
    await runReconcile(db, { now: later() });
    expect(await journalsWithKeyPrefix(db, worldId, "repayment_capture:")).toHaveLength(2); // capture + holders
    expect(await journalsWithKeyPrefix(db, worldId, "remainder_payout:")).toHaveLength(1);
    expect((await storedEvent(db, completed.id))?.worldId).toBe(worldId);
  });

  it("PAYMENT.CAPTURE.COMPLETED alone (approval webhook missed) settles the link via its related order id", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const link = await invoiceLink(db, borrower.loanId);
    await simApprove(db, link!.paypalOrderId!);
    const completed = event("PAYMENT.CAPTURE.COMPLETED", {
      id: "CAPTURE-X",
      status: "COMPLETED",
      supplementary_data: { related_ids: { order_id: link!.paypalOrderId } },
    });
    expect((await POST(webhookRequest(JSON.stringify(completed)))).status).toBe(200);
    expect((await getLoan(db, borrower.loanId)).status).toBe("repaid");
  });

  it("Fix round 1 (I1): a capture stored PENDING is settled by CAPTURE.COMPLETED (status used directly); a PENDING event stays unprocessed", async () => {
    const worldId = await createSimWorld(db);
    await fundPool(db, worldId, 30000);
    const borrower = await borrow(db, worldId);
    const orderId = (await invoiceLink(db, borrower.loanId))!.paypalOrderId!;
    await simApprove(db, orderId);
    await simSetCaptureStatus(db, orderId, "PENDING");
    await runReconcile(db, { now: later() });
    expect((await getLoan(db, borrower.loanId)).status).toBe("active");
    const [captureRow] = await db
      .select()
      .from(paypalOperations)
      .where(and(eq(paypalOperations.kind, "order.capture"), eq(paypalOperations.paypalId, orderId)));
    const captureId = (captureRow!.response as Data).captureId as string;

    const stillPending = event("PAYMENT.CAPTURE.PENDING", {
      id: captureId,
      status: "PENDING",
      supplementary_data: { related_ids: { order_id: orderId } },
    });
    expect((await POST(webhookRequest(JSON.stringify(stillPending)))).status).toBe(200);

    const completedPending = event("PAYMENT.CAPTURE.COMPLETED", {
      id: captureId,
      status: "PENDING",
      supplementary_data: { related_ids: { order_id: orderId } },
    });
    expect((await POST(webhookRequest(JSON.stringify(completedPending)))).status).toBe(200);
    expect((await storedEvent(db, completedPending.id))?.processedAt).toBeNull();
    expect((await getLoan(db, borrower.loanId)).status).toBe("active");

    // PayPal's side still says PENDING to a GET; the verified event's own status is what settles it.
    const completed = event("PAYMENT.CAPTURE.COMPLETED", {
      id: captureId,
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "400.00" },
      supplementary_data: { related_ids: { order_id: orderId } },
    });
    expect((await POST(webhookRequest(JSON.stringify(completed)))).status).toBe(200);
    expect((await getLoan(db, borrower.loanId)).status).toBe("repaid");
    expect((await storedEvent(db, completed.id))?.processedAt).toBeInstanceOf(Date);
    expect(await journalsWithKeyPrefix(db, worldId, "repayment_capture:")).toHaveLength(2);
  });

  it("an unknown resource → stored with no world, 200, no effect", async () => {
    const evt = event("CHECKOUT.ORDER.APPROVED", { id: "ORDER-NOBODY-KNOWS" });
    const res = await POST(webhookRequest(JSON.stringify(evt)));
    expect(res.status).toBe(200);
    const row = await storedEvent(db, evt.id);
    expect(row).toMatchObject({ verified: true, worldId: null });
    expect(
      await db.select().from(webhookEvents).where(and(eq(webhookEvents.paypalEventId, evt.id), isNull(webhookEvents.worldId))),
    ).toHaveLength(1);
  });

  it("a body over 64 KB → 413 without calling PayPal or storing anything", async () => {
    const big = JSON.stringify(event("SOMETHING.ELSE", { pad: "x".repeat(70 * 1024) }));
    const res = await POST(webhookRequest(big));
    expect(res.status).toBe(413);
    expect(verifyCalls).toBe(0);
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it("non-JSON (body or content type) → 400 without calling PayPal", async () => {
    expect((await POST(webhookRequest("not json{"))).status).toBe(400);
    const wrongType = new Request("http://localhost/api/webhooks/paypal", {
      method: "POST",
      headers: { "content-type": "text/plain", ...TRANSMISSION_HEADERS },
      body: JSON.stringify(event("SOMETHING.ELSE", {})),
    });
    expect((await POST(wrongType)).status).toBe(400);
    expect(verifyCalls).toBe(0);
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });
});
