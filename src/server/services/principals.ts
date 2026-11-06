import { randomUUID } from "crypto";

import { eq, sql } from "drizzle-orm";

import { sanitizeReturnTo } from "../auth/session";
import type { Db } from "../db/client";
import { principals } from "../db/schema";
import {
  buildCreateOrderRequest,
  buildGetOrderRequest,
  enqueueOperation,
  enqueueReadOperation,
  executeOperation,
  findOperationByPaypalId,
  type OperationKind,
  type OperationResult,
  type OperationResultByKind,
} from "../paypal/operations";
import { ensureMainWorldOnce, railForWorld } from "./worlds";

/**
 * Principals and "Verify with PayPal" (P2 Task 1). The OAuth "Log in
 * with PayPal" route needs a registered return URL we can't get
 * (docs/spikes.md), so a human proves who they are by approving a
 * $0.01 order: once `order.get` shows it `APPROVED` with a
 * `payer.payer_id`, the principal is upserted by that payer id. The
 * order is never captured — nothing here (and no capture handler is
 * registered for `identity_verification`, so neither the webhook nor the
 * cron) ever enqueues an `order.capture` for it; PayPal voids it later.
 *
 * Everything runs in the main world, outside any transaction (PayPal is
 * called via `executeOperation`).
 */

export type Principal = typeof principals.$inferSelect;

export const VERIFICATION_AMOUNT_CENTS = 1n;
export const VERIFICATION_DESCRIPTION = "Mandate identity check (not charged)";

export type VerificationErrorCode =
  /** The order id is malformed, unknown, or not a main-world identity order. */
  | "unknown_order"
  /** PayPal/sim didn't answer (create or get failed). */
  | "paypal_unavailable"
  /** The order exists but isn't `APPROVED` (not yet approved, cancelled, voided…). */
  | "not_approved"
  /** The approved order carries no payer id / email. */
  | "no_payer";

export class VerificationError extends Error {
  readonly code: VerificationErrorCode;
  constructor(code: VerificationErrorCode, message: string) {
    super(message);
    this.name = "VerificationError";
    this.code = code;
  }
}

/** PayPal order ids (and the sim rail's `SIMORDER-<uuid>`): letters, digits and dashes. */
const ORDER_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** The succeeded result's body, or `null` when the operation didn't succeed. */
function succeeded<K extends OperationKind>(result: OperationResult, kind: K): OperationResultByKind[K] | null {
  return result.kind === kind && result.status === "succeeded" && result.body !== null
    ? (result.body as OperationResultByKind[K])
    : null;
}

/** `${PUBLIC_BASE_URL}${path}`, falling back to `http://localhost:3000`. */
function publicUrl(path: string): string {
  const base = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
  return `${base.replace(/\/+$/, "")}${path}`;
}

export interface StartedVerification {
  approveUrl: string;
  orderId: string;
  verificationId: string;
  /** The sanitized `returnTo` (same-origin relative path, default `/dashboard`). */
  returnTo: string;
}

/**
 * Creates the $0.01 identity order in the main world (enqueue + execute,
 * no transaction) and returns where to send the human to approve it.
 * `returnTo` is not sent to PayPal — it is returned sanitized for the
 * caller to keep in the signed `mandate_verify` cookie. Throws `VerificationError("paypal_unavailable")`
 * when the order can't be created.
 */
export async function startVerification(
  db: Db,
  options: { returnTo?: string | null } = {},
): Promise<StartedVerification> {
  const { worldId } = await ensureMainWorldOnce(db);
  const rail = await railForWorld(db, worldId);
  const verificationId = randomUUID();

  const { operationId } = await enqueueOperation(db, {
    worldId,
    rail,
    kind: "order.create",
    purpose: "identity_verification",
    sourceId: verificationId,
    request: buildCreateOrderRequest({
      amountCents: VERIFICATION_AMOUNT_CENTS,
      description: VERIFICATION_DESCRIPTION,
      customId: verificationId,
      returnUrl: publicUrl("/verify/return"),
      cancelUrl: publicUrl("/verify/error?reason=cancelled"),
    }),
  });
  const result = await executeOperation(db, operationId, { ignoreBackoff: true });
  const created = succeeded(result, "order.create");
  if (!created) {
    throw new VerificationError("paypal_unavailable", "Could not create the PayPal verification order.");
  }
  return {
    approveUrl: created.approveUrl,
    orderId: created.orderId,
    verificationId,
    returnTo: sanitizeReturnTo(options.returnTo),
  };
}

/**
 * Completes a verification: `orderId` must be a main-world
 * `identity_verification` order that `order.get` shows `APPROVED` with a
 * payer id. Upserts the principal by `paypal_payer_id` (email/name
 * refreshed; `verified_at` kept from the first verification) and returns
 * it. Idempotent — the same order (or the same payer) always yields the
 * same principal. Never captures.
 */
export async function completeVerification(db: Db, orderId: string): Promise<Principal> {
  if (!ORDER_ID_RE.test(orderId)) {
    throw new VerificationError("unknown_order", "Malformed order id.");
  }
  const { worldId } = await ensureMainWorldOnce(db);
  const create = await findOperationByPaypalId(db, "order.create", orderId);
  if (!create || create.worldId !== worldId || create.purpose !== "identity_verification") {
    throw new VerificationError("unknown_order", "Not a Mandate identity check order.");
  }

  const { operationId } = await enqueueReadOperation(db, {
    worldId,
    rail: await railForWorld(db, worldId),
    kind: "order.get",
    request: buildGetOrderRequest(orderId),
  });
  const order = succeeded(await executeOperation(db, operationId, { ignoreBackoff: true }), "order.get");
  if (!order) {
    throw new VerificationError("paypal_unavailable", "Could not read the PayPal order.");
  }
  if (order.status !== "APPROVED") {
    throw new VerificationError("not_approved", `The PayPal order is ${order.status}, not APPROVED.`);
  }
  const payerId = order.payer?.payerId;
  const email = order.payer?.email;
  if (!payerId || !email) {
    throw new VerificationError("no_payer", "The approved PayPal order has no payer.");
  }

  const now = new Date();
  const [principal] = await db
    .insert(principals)
    .values({
      paypalPayerId: payerId,
      email,
      name: order.payer?.name ?? email,
      entityType: "individual",
      verifiedAt: now,
    })
    .onConflictDoUpdate({
      target: principals.paypalPayerId,
      set: {
        email,
        name: order.payer?.name ?? sql`${principals.name}`,
        verifiedAt: sql`coalesce(${principals.verifiedAt}, excluded.verified_at)`,
      },
    })
    .returning();
  if (!principal) {
    throw new Error(`Expected a principal for payer ${payerId} after upsert`);
  }
  return principal;
}

export async function getPrincipal(db: Db, principalId: string): Promise<Principal | null> {
  if (!/^[0-9a-f-]{36}$/i.test(principalId)) {
    return null;
  }
  const [row] = await db.select().from(principals).where(eq(principals.id, principalId)).limit(1);
  return row ?? null;
}
