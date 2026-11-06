import type { Db } from "../db/client";
import { operationRail } from "./operationRail";
import type { PaymentRail } from "./types";

/** Live PayPal sandbox rail: enqueue + execute through `paypal/operations.ts`. */
export function paypalRail(db: Db): PaymentRail {
  return operationRail(db, "paypal");
}
