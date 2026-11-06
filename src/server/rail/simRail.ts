import type { Db } from "../db/client";
import { operationRail } from "./operationRail";
import { simApprove } from "./simHandler";
import type { PaymentRail } from "./types";

export { SimRailError } from "./simHandler";

/**
 * Deterministic sim rail: the same enqueue + execute path as
 * `paypalRail`, with `executeOperation` dispatching `rail = 'sim'` rows to
 * the in-DB handler in `simHandler.ts` (semantics documented there).
 * `simApprove` stands in for the payer approving an order (tests/bots).
 */
export function simRail(
  db: Db,
): PaymentRail & { simApprove(orderId: string): Promise<void> } {
  return {
    ...operationRail(db, "sim"),
    simApprove: (orderId) => simApprove(db, orderId),
  };
}
