import type { Db } from "../db/client";
import * as orders from "../paypal/orders";
import * as payouts from "../paypal/payouts";
import type { PaymentRail } from "./types";

/** Live PayPal sandbox rail: every call goes through `paypalFetch`'s idempotent client. */
export function paypalRail(db: Db): PaymentRail {
  return {
    name: "paypal",

    async createCheckout(params) {
      const result = await orders.create(db, params);
      return { rail: "paypal", ...result };
    },

    async captureCheckout(params) {
      const result = await orders.capture(db, params);
      return { rail: "paypal", ...result };
    },

    async getCheckout(params) {
      const result = await orders.get(db, params);
      return { rail: "paypal", ...result };
    },

    async sendPayout(params) {
      const result = await payouts.send(db, params);
      return { rail: "paypal", ...result };
    },

    async getPayout(params) {
      const result = await payouts.get(db, params);
      return { rail: "paypal", ...result };
    },
  };
}
