import type { Db } from "../db/client";
import {
  PayPalApiError,
  buildCaptureOrderRequest,
  buildCreateOrderRequest,
  buildGetOrderRequest,
  buildGetPayoutRequest,
  buildSendPayoutRequest,
  enqueueOperation,
  enqueueReadOperation,
  errorBody,
  executeOperation,
  successBody,
  type OperationKind,
  type OperationResult,
  type OperationResultByKind,
} from "../paypal/operations";
import type { PaymentRail, RailName } from "./types";

/** A non-succeeded operation surfaced as the `PayPalApiError` rail callers expect. */
function toApiError(result: OperationResult): PayPalApiError {
  const error = errorBody(result);
  if (!error) {
    return new PayPalApiError({
      status: 0,
      name: "OPERATION_IN_FLIGHT",
      details: { operationId: result.operationId, status: result.status },
    });
  }
  return new PayPalApiError({
    status: result.httpStatus ?? 0,
    name: error.issue ?? error.name,
    details: { ...error, operationId: result.operationId, operationStatus: result.status },
    debugId: error.debugId ?? undefined,
  });
}

/**
 * The one rail implementation: each method enqueues an operation on
 * `rail` and executes it immediately (`ignoreBackoff`: this is a direct,
 * synchronous call), returning the parsed result or throwing
 * `PayPalApiError`. `paypalRail` and `simRail` differ only in `rail`.
 */
export function operationRail(db: Db, rail: RailName): PaymentRail {
  async function run<K extends OperationKind>(
    kind: K,
    operationId: string,
  ): Promise<{ operationId: string; result: OperationResultByKind[K] }> {
    const outcome = await executeOperation(db, operationId, { ignoreBackoff: true });
    if (outcome.status !== "succeeded") {
      throw toApiError(outcome);
    }
    return { operationId, result: successBody(outcome, kind) };
  }

  return {
    name: rail,

    async createCheckout(params) {
      const { operationId } = await enqueueOperation(db, {
        worldId: params.worldId,
        rail,
        kind: "order.create",
        purpose: params.purpose,
        sourceId: params.sourceId,
        request: buildCreateOrderRequest(params),
      });
      const { result } = await run("order.create", operationId);
      return { rail, operationId, ...result };
    },

    async captureCheckout(params) {
      const { operationId } = await enqueueOperation(db, {
        worldId: params.worldId,
        rail,
        kind: "order.capture",
        purpose: params.purpose,
        sourceId: params.sourceId,
        request: buildCaptureOrderRequest(params.orderId),
      });
      const { result } = await run("order.capture", operationId);
      return {
        rail,
        operationId,
        orderId: result.orderId,
        recovered: result.recovered,
        status: result.status,
        captureStatus: result.captureStatus,
        captureId: result.captureId,
        amountCents: BigInt(result.amountCents),
      };
    },

    async getCheckout(params) {
      const { operationId } = await enqueueReadOperation(db, {
        worldId: params.worldId,
        rail,
        kind: "order.get",
        request: buildGetOrderRequest(params.orderId),
      });
      const { result } = await run("order.get", operationId);
      return { rail, operationId, orderId: result.orderId, status: result.status };
    },

    async sendPayout(params) {
      const { operationId } = await enqueueOperation(db, {
        worldId: params.worldId,
        rail,
        kind: "payout.send",
        purpose: params.purpose,
        sourceId: params.sourceId,
        request: buildSendPayoutRequest(params),
      });
      const { result } = await run("payout.send", operationId);
      return { rail, operationId, ...result };
    },

    async getPayout(params) {
      const { operationId } = await enqueueReadOperation(db, {
        worldId: params.worldId,
        rail,
        kind: "payout.get",
        request: buildGetPayoutRequest(params.batchId),
      });
      const { result } = await run("payout.get", operationId);
      return { rail, operationId, batchStatus: result.batchStatus, items: result.items };
    },
  };
}
