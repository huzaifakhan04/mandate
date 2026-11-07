/**
 * Compile-time PayPal Orders v2 contract, taken from the official
 * APIMatic-generated `@paypal/paypal-server-sdk` models (type-only — this
 * module emits no runtime code and pulls nothing into the bundle).
 *
 * Why types and not the SDK's HTTP path: every PayPal call here is a queued
 * `paypal_operations` row whose *stored wire request* is re-sent verbatim
 * (possibly by another process) under a derived `PayPal-Request-Id`, the
 * sim rail answers the same wire shape in-DB, and the classifier needs the
 * raw status + body (Rulings F/H). The SDK builds requests from camelCase
 * models at call time, mints its own per-call `Idempotency-Key`, and turns a
 * malformed 2xx into a `DecodeError` — so we keep our transport and adopt
 * the SDK's *models* as the contract our wire bodies must satisfy. See
 * `docs/sponsors/apimatic-context-plugin-audit.md`.
 *
 * SDK models are camelCase; on the wire the SDK's schemas rename each key
 * (`purchaseUnits` → `purchase_units`, `debugId` → `debug_id`, …). `Wire<T>`
 * applies that same camel→snake renaming at the type level, so a misspelled
 * or renamed wire key in a builder/parser is a type error.
 */
import type {
  CaptureStatus,
  CheckoutPaymentIntent,
  CustomError,
  LinkDescription,
  Money,
  Order,
  OrderRequest,
  OrdersCapture,
  OrderStatus,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  SellerReceivableBreakdown,
} from "@paypal/paypal-server-sdk";

type CamelToSnake<S extends string> = S extends `${infer Head}${infer Tail}`
  ? `${Head extends Lowercase<Head> ? Head : `_${Lowercase<Head>}`}${CamelToSnake<Tail>}`
  : S;

/**
 * An SDK model as it appears on the wire: keys snake_cased, enums widened to
 * their string values (the SDK's TS `enum`s are `"CAPTURE"` etc. on the
 * wire), recursively through arrays and nested models. Optionality is kept.
 */
export type Wire<T> = T extends string
  ? `${T}`
  : T extends number | boolean | bigint | null | undefined
    ? T
    : T extends readonly (infer U)[]
      ? Wire<U>[]
      : T extends object
        ? { [K in keyof T as K extends string ? CamelToSnake<K> : never]: Wire<T[K]> }
        : T;

/** `POST /v2/checkout/orders` body (SDK `OrderRequest`). */
export type WireOrderRequest = Wire<OrderRequest>;
/** Orders v2 response (create / capture / get all return `Order`). */
export type WireOrder = Wire<Order>;
export type WireOrdersCapture = Wire<OrdersCapture>;
export type WireSellerReceivableBreakdown = Wire<SellerReceivableBreakdown>;
export type WireMoney = Wire<Money>;
export type WireLinkDescription = Wire<LinkDescription>;

/**
 * PayPal's error body (SDK `CustomError` result: `name`, `message`,
 * `debug_id`, `details[].issue`) — already wire-keyed in the SDK.
 */
export type WirePayPalError = NonNullable<CustomError["result"]>;

/** Enum wire values, straight from the SDK's enums. */
export type WireOrderStatus = `${OrderStatus}`;
export type WireCaptureStatus = `${CaptureStatus}`;
export type WireIntent = `${CheckoutPaymentIntent}`;
export type WireUserAction = `${PaypalExperienceUserAction}`;
export type WireShippingPreference = `${PaypalWalletContextShippingPreference}`;
export type WirePurchaseUnitRequest = WireOrderRequest["purchase_units"][number];
