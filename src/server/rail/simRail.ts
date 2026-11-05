import { randomUUID } from "crypto";

import type { Db } from "../db/client";
import { scoped } from "../db/scoped";
import { paypalOperations } from "../db/schema";
import { redact } from "../paypal/redact";
import type { PaymentRail } from "./types";

type SimOrderStatus = "CREATED" | "APPROVED" | "COMPLETED";

interface SimOrder {
  worldId: string;
  orderId: string;
  status: SimOrderStatus;
  amountCents: bigint;
}

interface SimPayoutBatch {
  worldId: string;
  batchStatus: "SUCCESS" | "FAILED";
  items: { itemId?: string; transactionStatus: string }[];
}

// Module-level in-memory stores. The sim rail never talks to a real
// payment network; it only needs to behave consistently within this
// process, which a shared map (keyed by a random id per call) gives us
// without any extra schema.
const simOrders = new Map<string, SimOrder>();
const simPayouts = new Map<string, SimPayoutBatch>();

export class SimRailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimRailError";
  }
}

/**
 * Deterministic in-memory rail for tests and demos, with no network
 * calls. It still writes `paypal_operations` rows (with `rail: "sim"`)
 * so downstream auditing/ledger code behaves the same regardless of
 * which rail a world runs on.
 */
export function simRail(
  db: Db,
): PaymentRail & { simApprove(orderId: string): void } {
  async function recordOperation(
    worldId: string,
    kind: string,
    request: unknown,
    response: unknown,
    status: "succeeded" | "failed",
  ): Promise<string> {
    const [row] = await scoped(db, worldId).insert(paypalOperations, {
      rail: "sim",
      kind,
      requestId: randomUUID(),
      status,
      request: redact(request),
      response: redact(response),
      httpStatus: 200,
      attempts: 1,
    });
    if (!row) {
      throw new Error("expected sim paypal_operations row to be inserted");
    }
    return row.id;
  }

  return {
    name: "sim",

    async createCheckout(params) {
      const orderId = randomUUID();
      simOrders.set(orderId, {
        worldId: params.worldId,
        orderId,
        status: "CREATED",
        amountCents: params.amountCents,
      });

      const operationId = await recordOperation(
        params.worldId,
        "order.create",
        params,
        { orderId, status: "CREATED" },
        "succeeded",
      );

      return {
        rail: "sim",
        operationId,
        orderId,
        approveUrl: `https://sim.paypal.local/approve/${orderId}`,
        status: "CREATED",
      };
    },

    async captureCheckout(params) {
      const order = simOrders.get(params.orderId);
      if (!order || order.worldId !== params.worldId) {
        throw new SimRailError(`Unknown sim order ${params.orderId}`);
      }
      if (order.status !== "APPROVED") {
        throw new SimRailError(
          `Sim order ${params.orderId} must be approved before capture (status=${order.status})`,
        );
      }

      order.status = "COMPLETED";
      const captureId = randomUUID();

      const operationId = await recordOperation(
        params.worldId,
        "order.capture",
        params,
        { status: "COMPLETED", captureId },
        "succeeded",
      );

      return {
        rail: "sim",
        operationId,
        status: "COMPLETED",
        captureId,
        amountCents: order.amountCents,
      };
    },

    async getCheckout(params) {
      const order = simOrders.get(params.orderId);
      if (!order || order.worldId !== params.worldId) {
        throw new SimRailError(`Unknown sim order ${params.orderId}`);
      }

      const operationId = await recordOperation(
        params.worldId,
        "order.get",
        params,
        { status: order.status },
        "succeeded",
      );

      return {
        rail: "sim",
        operationId,
        orderId: order.orderId,
        status: order.status,
      };
    },

    async sendPayout(params) {
      const failed = params.receiver.includes("fail");
      const batchId = randomUUID();
      const itemId = randomUUID();
      const batchStatus = failed ? "FAILED" : "SUCCESS";

      simPayouts.set(batchId, {
        worldId: params.worldId,
        batchStatus,
        items: [{ itemId, transactionStatus: batchStatus }],
      });

      const operationId = await recordOperation(
        params.worldId,
        "payout.send",
        params,
        { batchId, batchStatus },
        failed ? "failed" : "succeeded",
      );

      return { rail: "sim", operationId, batchId, itemId, batchStatus };
    },

    async getPayout(params) {
      const batch = simPayouts.get(params.batchId);
      if (!batch || batch.worldId !== params.worldId) {
        throw new SimRailError(`Unknown sim payout batch ${params.batchId}`);
      }

      const operationId = await recordOperation(
        params.worldId,
        "payout.get",
        params,
        batch,
        "succeeded",
      );

      return {
        rail: "sim",
        operationId,
        batchStatus: batch.batchStatus,
        items: batch.items,
      };
    },

    simApprove(orderId: string): void {
      const order = simOrders.get(orderId);
      if (!order) {
        throw new SimRailError(`Unknown sim order ${orderId}`);
      }
      order.status = "APPROVED";
    },
  };
}
