import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { paypalOperations } from "../db/schema";
import { ownedPrivateWorld } from "./privateWorldAccess";

/**
 * P2 final review (I-1): the owner's stand-in for "approve in PayPal" in a
 * private world. Sim orders there carry a `payer-action` link to
 * `/dashboard/worlds/<worldId>/checkouts/<orderId>/approve`; the signed-in
 * owner of that (active, private) world opens it and approves, which is
 * `simApprove` (called by the route, `auth/simApproveRoutes.ts` — services
 * never import the rails) — then the agent's `confirm_checkout` captures
 * as usual.
 *
 * Only the world's owner, only an order created in that world on the sim
 * rail: anything else (another principal, the main world, an archived
 * world, an unknown order or one from another world) is `null` → 404.
 */

const ORDER_ID_RE = /^SIMORDER-[0-9a-f-]{36}$/i;

export type SimCheckoutStatus = "PAYER_ACTION_REQUIRED" | "APPROVED" | "COMPLETED";

export interface SimCheckoutView {
  worldId: string;
  worldName: string;
  orderId: string;
  amountCents: bigint;
  status: SimCheckoutStatus;
  /** Where the payer lands after approving: the order's `/checkout/<kind>/return?token=<orderId>`. */
  returnPath: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** The order's own return page (path + `?token=`), or the world's dashboard when it has none. */
function returnPathOf(executableRequest: unknown, worldId: string, orderId: string): string {
  const context = record(record(record(record(executableRequest).body).payment_source).paypal).experience_context;
  const returnUrl = record(context).return_url;
  if (typeof returnUrl === "string") {
    try {
      const { pathname } = new URL(returnUrl);
      if (/^\/checkout\/[a-z]+\/return$/.test(pathname)) {
        return `${pathname}?token=${encodeURIComponent(orderId)}`;
      }
    } catch {
      // A malformed return URL falls through to the dashboard.
    }
  }
  return `/dashboard?world=${worldId}`;
}

/** The order as its world's owner sees it, or `null` (→ 404). */
export async function findOwnedSimCheckout(
  db: Db,
  principalId: string,
  worldId: string,
  orderId: string,
): Promise<SimCheckoutView | null> {
  if (!ORDER_ID_RE.test(orderId)) {
    return null;
  }
  const world = await ownedPrivateWorld(db, principalId, worldId);
  if (!world || world.railMode !== "sim") {
    return null;
  }
  const t = paypalOperations;
  const [row] = await db
    .select({ simState: t.simState, executableRequest: t.executableRequest })
    .from(t)
    .where(
      and(
        eq(t.worldId, world.id),
        eq(t.rail, "sim"),
        eq(t.kind, "order.create"),
        sql`${t.simState}->>'orderId' = ${orderId}`,
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  const state = record(row.simState);
  return {
    worldId: world.id,
    worldName: world.name,
    orderId,
    amountCents: BigInt(typeof state.amountCents === "string" ? state.amountCents : "0"),
    status: (state.status as SimCheckoutStatus) ?? "PAYER_ACTION_REQUIRED",
    returnPath: returnPathOf(row.executableRequest, world.id, orderId),
  };
}
