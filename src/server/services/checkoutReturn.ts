import type { Db } from "../db/client";
import { describeError } from "../db/errors";
import { findOperationByPaypalId } from "../paypal/operations";
import { settleCheckoutByOrderId } from "./checkouts";

/**
 * I3 (final review): the PayPal return/cancel landing pages
 * (`/checkout/{kind}/{result}`) that every order is created with.
 */

export const CHECKOUT_KINDS = ["notes", "invoice", "repay", "guarantee"] as const;
export const CHECKOUT_RESULTS = ["return", "cancel"] as const;
export type CheckoutKind = (typeof CHECKOUT_KINDS)[number];
export type CheckoutResult = (typeof CHECKOUT_RESULTS)[number];

export interface CheckoutPageCopy {
  kind: CheckoutKind;
  result: CheckoutResult;
  title: string;
  message: string;
}

/** The page's copy, or `null` for an unknown kind/result (→ 404). */
export function checkoutPageCopy(kind: string, result: string): CheckoutPageCopy | null {
  if (!(CHECKOUT_KINDS as readonly string[]).includes(kind) || !(CHECKOUT_RESULTS as readonly string[]).includes(result)) {
    return null;
  }
  const k = kind as CheckoutKind;
  const r = result as CheckoutResult;
  if (r === "cancel") {
    return { kind: k, result: r, title: "Payment cancelled", message: "Payment cancelled. Nothing was charged." };
  }
  if (k === "invoice") {
    return { kind: k, result: r, title: "Thank you", message: "Thanks — your payment to Mandate is being processed." };
  }
  if (k === "guarantee") {
    return {
      kind: k,
      result: r,
      title: "Guarantee paid",
      message: "Thank you — your guarantee payment is being processed. The loan shows as recovered on your dashboard once it settles.",
    };
  }
  return {
    kind: k,
    result: r,
    title: "Payment approved",
    message: "Payment approved. You can close this tab — your agent will see it settle within a minute or two.",
  };
}

export type ReturnSettlement =
  | { status: "invalid_token" }
  | { status: "unknown_order" }
  | { status: "settled"; checkoutStatus: string }
  | { status: "error" }
  | { status: "timeout" };

/** PayPal order ids (and the sim rail's `SIMORDER-<uuid>`): letters, digits and dashes. */
const ORDER_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export interface SettleOnReturnOptions {
  /** How long the page may wait (default 5s); settlement keeps running past it. */
  timeoutMs?: number;
  /** Receives the full settlement promise so the caller can keep it alive (`after()`). Never rejects. */
  keepAlive?: (work: Promise<ReturnSettlement>) => void;
  /** Injectable for tests. */
  settle?: typeof settleCheckoutByOrderId;
}

/**
 * On a `return` landing with `?token=<orderId>`: finds the world that
 * created the order (its `order.create` operation) and runs the same
 * agent-less, idempotent settlement the webhook and cron use
 * (`settleCheckoutByOrderId`) — so the payment usually settles before the
 * agent next looks. Never throws (errors are logged without details and
 * reported as `error`) and resolves within `timeoutMs` (`timeout`) even if
 * PayPal is slow; the settlement itself continues via `keepAlive`.
 */
export async function settleOnReturn(db: Db, token: string, options: SettleOnReturnOptions = {}): Promise<ReturnSettlement> {
  const { timeoutMs = 5_000, keepAlive, settle = settleCheckoutByOrderId } = options;
  if (!ORDER_ID_RE.test(token)) {
    return { status: "invalid_token" };
  }

  const work: Promise<ReturnSettlement> = (async (): Promise<ReturnSettlement> => {
    const create = await findOperationByPaypalId(db, "order.create", token);
    if (!create) {
      return { status: "unknown_order" };
    }
    const result = await settle(db, create.worldId, token);
    return { status: "settled", checkoutStatus: result.status };
  })().catch((err: unknown): ReturnSettlement => {
    console.error(`[checkout-return] settle ${token} failed: ${describeError(err)}`);
    return { status: "error" };
  });
  keepAlive?.(work);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ReturnSettlement>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
