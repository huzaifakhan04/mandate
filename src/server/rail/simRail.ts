import { randomUUID } from "crypto";

import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { paypalOperations } from "../db/schema";
import { PayPalApiError } from "../paypal/fetch";
import { assertPositiveAmountCents } from "../paypal/orders";
import { redact } from "../paypal/redact";
import type { PaymentRail } from "./types";

type SimOrderStatus = "PAYER_ACTION_REQUIRED" | "APPROVED" | "COMPLETED";

/**
 * The sim order's full state, persisted as the `response` json of its
 * `order.create` `paypal_operations` row (not a module-level `Map` —
 * this rail must work across separate serverless instances, so its
 * state has to live in the database like everything else). `simApprove`
 * and `captureCheckout` update this row in place as the order
 * progresses through the same statuses PayPal itself uses.
 */
interface SimOrderState {
  orderId: string;
  status: SimOrderStatus;
  amountCents: string;
  captureId?: string;
}

interface SimPayoutItemState {
  itemId?: string;
  transactionStatus: "SUCCESS" | "FAILED";
}

interface SimPayoutState {
  batchId: string;
  batchStatus: "SUCCESS" | "FAILED";
  items: SimPayoutItemState[];
}

export class SimRailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimRailError";
  }
}

interface InsertOrReuseResult {
  id: string;
  row: typeof paypalOperations.$inferSelect;
}

/**
 * Inserts a sim `paypal_operations` row for a fresh logical operation
 * (order/payout), or — when `explicitId` names a row that already
 * exists — reuses it instead of minting a new PayPal-side id. Mirrors
 * `paypalFetch`'s `ensureOperationRow` so the real and sim rails give
 * callers the same idempotency guarantee for a caller-supplied
 * `operationId`.
 */
async function insertOrReuse(
  db: Db,
  worldId: string,
  kind: string,
  explicitId: string | undefined,
  build: () => {
    paypalId: string;
    request: unknown;
    response: unknown;
    status: "succeeded" | "failed";
  },
): Promise<InsertOrReuseResult> {
  const id = explicitId ?? randomUUID();
  const built = build();

  const [inserted] = await db
    .insert(paypalOperations)
    .values({
      id,
      worldId,
      rail: "sim",
      kind,
      requestId: id,
      paypalId: built.paypalId,
      status: built.status,
      request: redact(built.request),
      response: redact(built.response),
      httpStatus: built.status === "succeeded" ? 200 : 422,
      attempts: 1,
    })
    .onConflictDoNothing({ target: paypalOperations.id })
    .returning();

  if (inserted) {
    return { id: inserted.id, row: inserted };
  }

  const [existing] = await db
    .select()
    .from(paypalOperations)
    .where(
      and(eq(paypalOperations.id, id), eq(paypalOperations.worldId, worldId)),
    );

  if (!existing) {
    throw new SimRailError(
      `operationId ${id} belongs to a different world, or vanished after a conflicting insert — refusing to reuse it`,
    );
  }

  if (existing.rail !== "sim" || existing.kind !== kind) {
    throw new SimRailError(
      `operationId ${id} was already used for a different operation (rail=${existing.rail}, kind=${existing.kind}); refusing to reuse it for rail=sim, kind=${kind}`,
    );
  }

  return { id: existing.id, row: existing };
}

async function findRowByPaypalId(
  db: Db,
  worldId: string,
  kind: string,
  paypalId: string,
): Promise<typeof paypalOperations.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(paypalOperations)
    .where(
      and(
        eq(paypalOperations.worldId, worldId),
        eq(paypalOperations.kind, kind),
        eq(paypalOperations.paypalId, paypalId),
      ),
    )
    .limit(1);
  return row;
}

function orderNotFoundError(orderId: string): PayPalApiError {
  return new PayPalApiError({
    status: 404,
    name: "ORDER_NOT_FOUND",
    details: { orderId },
  });
}

/**
 * Deterministic in-memory-free rail for tests and demos: no network
 * calls, but every bit of state (order/payout lifecycle) lives in
 * `paypal_operations` rows (with `rail: "sim"`), scoped by world, so
 * this works the same whether or not the process restarts between
 * calls. Statuses mirror PayPal's own: a fresh checkout is
 * `PAYER_ACTION_REQUIRED` (not `CREATED`), capturing an order that
 * hasn't been through `simApprove` throws a `PayPalApiError`-shaped
 * `ORDER_NOT_APPROVED` (422) exactly like a real rejected capture would,
 * and a payout to a receiver containing `"fail"` reports a `FAILED`
 * item.
 */
export function simRail(
  db: Db,
): PaymentRail & { simApprove(orderId: string): Promise<void> } {
  return {
    name: "sim",

    async createCheckout(params) {
      assertPositiveAmountCents(params.amountCents);

      const { id, row } = await insertOrReuse(
        db,
        params.worldId,
        "order.create",
        params.operationId,
        () => {
          const orderId = randomUUID();
          const state: SimOrderState = {
            orderId,
            status: "PAYER_ACTION_REQUIRED",
            amountCents: params.amountCents.toString(),
          };
          return {
            paypalId: orderId,
            request: params,
            response: state,
            status: "succeeded",
          };
        },
      );

      const state = row.response as unknown as SimOrderState;
      const orderId = row.paypalId ?? state.orderId;

      return {
        rail: "sim",
        operationId: id,
        orderId,
        approveUrl: `https://sim.paypal.local/payer-action/${orderId}`,
        status: state.status,
      };
    },

    async captureCheckout(params) {
      const row = await findRowByPaypalId(
        db,
        params.worldId,
        "order.create",
        params.orderId,
      );
      if (!row) {
        throw orderNotFoundError(params.orderId);
      }

      const state = row.response as unknown as SimOrderState;

      const rejectCapture = async (error: PayPalApiError): Promise<never> => {
        const auditId = randomUUID();
        await db.insert(paypalOperations).values({
          id: auditId,
          worldId: params.worldId,
          rail: "sim",
          kind: "order.capture",
          requestId: auditId,
          paypalId: params.orderId,
          status: "failed",
          request: redact(params),
          response: redact({ name: error.name, status: state.status }),
          httpStatus: 422,
          attempts: 1,
          lastError: error.name,
        });
        throw error;
      };

      if (state.status === "COMPLETED") {
        await rejectCapture(
          new PayPalApiError({
            status: 422,
            name: "ORDER_ALREADY_CAPTURED",
            details: redact({ orderId: params.orderId }),
          }),
        );
      }
      if (state.status !== "APPROVED") {
        await rejectCapture(
          new PayPalApiError({
            status: 422,
            name: "ORDER_NOT_APPROVED",
            details: redact({ orderId: params.orderId, status: state.status }),
          }),
        );
      }

      const captureId = randomUUID();
      const newState: SimOrderState = {
        ...state,
        status: "COMPLETED",
        captureId,
      };

      // Conditional transition (`WHERE response->>'status' = 'APPROVED'`),
      // checked and applied atomically by Postgres at UPDATE time — so
      // two concurrent captures of the same order can't both "win": the
      // second one to actually execute sees the row already COMPLETED
      // and updates zero rows, however close together the two calls
      // started.
      const [updated] = await db
        .update(paypalOperations)
        .set({ response: redact(newState) })
        .where(
          and(
            eq(paypalOperations.id, row.id),
            sql`(${paypalOperations.response}->>'status') = 'APPROVED'`,
          ),
        )
        .returning();

      if (!updated) {
        await rejectCapture(
          new PayPalApiError({
            status: 422,
            name: "ORDER_ALREADY_CAPTURED",
            details: redact({ orderId: params.orderId }),
          }),
        );
      }

      const auditId = randomUUID();
      await db.insert(paypalOperations).values({
        id: auditId,
        worldId: params.worldId,
        rail: "sim",
        kind: "order.capture",
        requestId: auditId,
        paypalId: params.orderId,
        status: "succeeded",
        request: redact(params),
        response: redact({ status: "COMPLETED", captureId }),
        httpStatus: 200,
        attempts: 1,
      });

      return {
        rail: "sim",
        operationId: auditId,
        status: "COMPLETED",
        captureStatus: "COMPLETED",
        captureId,
        amountCents: BigInt(state.amountCents),
      };
    },

    async getCheckout(params) {
      const row = await findRowByPaypalId(
        db,
        params.worldId,
        "order.create",
        params.orderId,
      );
      if (!row) {
        throw orderNotFoundError(params.orderId);
      }

      const state = row.response as unknown as SimOrderState;
      return {
        rail: "sim",
        operationId: row.id,
        orderId: params.orderId,
        status: state.status,
      };
    },

    async sendPayout(params) {
      assertPositiveAmountCents(params.amountCents);

      const failed = params.receiver.includes("fail");

      const { id, row } = await insertOrReuse(
        db,
        params.worldId,
        "payout.send",
        params.operationId,
        () => {
          const batchId = randomUUID();
          const itemId = randomUUID();
          const batchStatus: "SUCCESS" | "FAILED" = failed
            ? "FAILED"
            : "SUCCESS";
          const state: SimPayoutState = {
            batchId,
            batchStatus,
            items: [{ itemId, transactionStatus: batchStatus }],
          };
          return {
            paypalId: batchId,
            request: params,
            response: state,
            status: failed ? "failed" : "succeeded",
          };
        },
      );

      const state = row.response as unknown as SimPayoutState;
      const batchId = row.paypalId ?? state.batchId;

      return {
        rail: "sim",
        operationId: id,
        batchId,
        itemId: state.items[0]?.itemId,
        batchStatus: state.batchStatus,
      };
    },

    async getPayout(params) {
      const row = await findRowByPaypalId(
        db,
        params.worldId,
        "payout.send",
        params.batchId,
      );
      if (!row) {
        throw new PayPalApiError({
          status: 404,
          name: "PAYOUT_NOT_FOUND",
          details: { batchId: params.batchId },
        });
      }

      const state = row.response as unknown as SimPayoutState;
      return {
        rail: "sim",
        operationId: row.id,
        batchStatus: state.batchStatus,
        items: state.items,
      };
    },

    /**
     * Test/demo helper with no `worldId` parameter (it mirrors the
     * brief's `simApprove(orderId)` signature exactly), so it looks the
     * order row up by `paypalId` alone rather than through `scoped()`.
     * `orderId` is a `randomUUID()` minted by `createCheckout`, so a
     * collision across worlds is not a realistic risk — but this is
     * intentionally the one place in this module that doesn't scope by
     * world, and must never be used as a model for anything reachable
     * from an actual agent/tool call.
     */
    async simApprove(orderId: string): Promise<void> {
      const [row] = await db
        .select()
        .from(paypalOperations)
        .where(
          and(
            eq(paypalOperations.kind, "order.create"),
            eq(paypalOperations.paypalId, orderId),
          ),
        )
        .limit(1);

      if (!row) {
        throw new SimRailError(`Unknown sim order ${orderId}`);
      }

      const state = row.response as unknown as SimOrderState;

      // Mirrors `captureCheckout`'s guard: approving is only a valid
      // transition from `PAYER_ACTION_REQUIRED`. An order that's already
      // `APPROVED` or `COMPLETED` must not be silently re-approved (that
      // would let `approve -> capture -> approve -> capture` double-spend
      // against the same order), so those throw a `PayPalApiError`-shaped
      // error exactly like a real PayPal re-approval attempt would.
      if (state.status === "COMPLETED") {
        throw new PayPalApiError({
          status: 422,
          name: "ORDER_ALREADY_CAPTURED",
          details: redact({ orderId }),
        });
      }
      if (state.status === "APPROVED") {
        throw new PayPalApiError({
          status: 422,
          name: "ORDER_ALREADY_APPROVED",
          details: redact({ orderId }),
        });
      }

      const newState: SimOrderState = { ...state, status: "APPROVED" };

      // Conditional transition, same pattern (and same reasoning) as
      // `captureCheckout`'s `UPDATE ... WHERE status = 'APPROVED'`: only a
      // row still in `PAYER_ACTION_REQUIRED` is moved to `APPROVED`, so a
      // concurrent/duplicate approve of an already-approved-or-captured
      // order can't win a race against the checks above.
      const [updated] = await db
        .update(paypalOperations)
        .set({ response: redact(newState) })
        .where(
          and(
            eq(paypalOperations.id, row.id),
            sql`(${paypalOperations.response}->>'status') = 'PAYER_ACTION_REQUIRED'`,
          ),
        )
        .returning();

      if (!updated) {
        throw new PayPalApiError({
          status: 422,
          name: "ORDER_ALREADY_APPROVED",
          details: redact({ orderId }),
        });
      }
    },
  };
}
