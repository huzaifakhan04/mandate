import { describe, expect, it } from "vitest";

import { InvalidAmountError } from "@/server/paypal/orders";
import {
  batchIdFromPath,
  buildGetPayoutRequest,
  buildSendPayoutRequest,
  parseGetPayoutResponse,
  parseSendPayoutResponse,
  withSenderBatchId,
} from "@/server/paypal/payouts";

const sendParams = {
  receiver: "ok@example.com",
  receiverType: "EMAIL" as const,
  amountCents: 500n,
  senderItemId: "item-1",
};

describe("payouts request builders / response parsers", () => {
  it("builds a single-item USD batch; sender_batch_id is stamped separately", () => {
    const request = withSenderBatchId(buildSendPayoutRequest(sendParams), "op-1");
    expect(request).toMatchObject({
      method: "POST",
      path: "/v1/payments/payouts",
      body: {
        sender_batch_header: { sender_batch_id: "op-1" },
        items: [
          {
            recipient_type: "EMAIL",
            amount: { value: "5.00", currency: "USD" },
            receiver: "ok@example.com",
            sender_item_id: "item-1",
          },
        ],
      },
    });
  });

  it("rejects a zero/negative amountCents when building", () => {
    expect(() => buildSendPayoutRequest({ ...sendParams, amountCents: 0n })).toThrow(
      InvalidAmountError,
    );
  });

  it("URL-encodes the batch id in get paths and round-trips it", () => {
    const request = buildGetPayoutRequest("B/1");
    expect(request).toEqual({ method: "GET", path: "/v1/payments/payouts/B%2F1" });
    expect(batchIdFromPath(request.path)).toBe("B/1");
  });

  it("parses a live-style send response with no items", () => {
    expect(
      parseSendPayoutResponse({ batch_header: { payout_batch_id: "B1", batch_status: "PENDING" } }),
    ).toEqual({ batchId: "B1", batchStatus: "PENDING", item: null });
  });

  it("parses a get response's items", () => {
    expect(
      parseGetPayoutResponse({
        batch_header: { payout_batch_id: "B1", batch_status: "SUCCESS" },
        items: [{ payout_item_id: "I1", transaction_status: "UNCLAIMED" }],
      }),
    ).toEqual({
      batchId: "B1",
      batchStatus: "SUCCESS",
      items: [{ itemId: "I1", transactionStatus: "UNCLAIMED" }],
    });
  });

  it("throws on a response without a batch header", () => {
    expect(() => parseSendPayoutResponse({})).toThrow(/batch_header/);
  });
});
