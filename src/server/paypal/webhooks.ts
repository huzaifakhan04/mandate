import { randomUUID } from "crypto";

import { eq } from "drizzle-orm";

import type { Db } from "../db/client";
import { webhookEvents } from "../db/schema";
import { PayPalConfigError } from "./config";
import { PayPalNetworkError, paypalFetch } from "./fetch";

/**
 * Task 8: PayPal webhook signature verification and the `webhook_events`
 * store. Lives in `paypal/` (allowlisted) because it calls `paypalFetch`
 * directly — verification moves no money and is not an operation — and
 * because `webhook_events.world_id` is nullable (an event for a resource
 * no world knows is still stored), which `scoped()` can't express.
 *
 * Never call `verifyWebhookSignature` inside a DB transaction.
 */

/** The transmission headers PayPal signs a delivery with (lower-case, as `Headers` returns them). */
const TRANSMISSION_HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

export type WebhookVerification =
  /** PayPal answered `verification_status: SUCCESS`. */
  | { outcome: "verified" }
  /** Definitely not verified: missing headers / webhook id, `FAILURE`, or a 4xx from PayPal. */
  | { outcome: "unverified"; reason: string }
  /** Couldn't ask PayPal (network, 5xx, credentials): the sender should retry later. */
  | { outcome: "error"; reason: string };

/**
 * Verifies a delivery with `POST /v1/notifications/verify-webhook-signature`
 * (PayPal's postback verification), passing the transmission headers,
 * `PAYPAL_WEBHOOK_ID` and the parsed event. Missing headers or an unset
 * `PAYPAL_WEBHOOK_ID` are `unverified` without calling PayPal (fail
 * closed).
 */
export async function verifyWebhookSignature(headers: Headers, event: unknown): Promise<WebhookVerification> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    return { outcome: "unverified", reason: "webhook_id_not_configured" };
  }
  const transmission: Record<string, string> = {};
  for (const [field, header] of Object.entries(TRANSMISSION_HEADERS)) {
    const value = headers.get(header);
    if (!value) {
      return { outcome: "unverified", reason: `missing_header:${header}` };
    }
    transmission[field] = value;
  }

  let response;
  try {
    response = await paypalFetch({
      method: "POST",
      path: "/v1/notifications/verify-webhook-signature",
      body: { ...transmission, webhook_id: webhookId, webhook_event: event },
      requestId: randomUUID(),
    });
  } catch (err) {
    if (err instanceof PayPalNetworkError || err instanceof PayPalConfigError) {
      return { outcome: "error", reason: err.name };
    }
    throw err;
  }

  if (response.httpStatus >= 500 || response.httpStatus === 429 || response.httpStatus === 401) {
    return { outcome: "error", reason: `verify_http_${response.httpStatus}` };
  }
  if (response.httpStatus < 200 || response.httpStatus >= 300) {
    return { outcome: "unverified", reason: `verify_http_${response.httpStatus}` };
  }
  const status =
    response.body !== null && typeof response.body === "object"
      ? (response.body as Record<string, unknown>).verification_status
      : undefined;
  return status === "SUCCESS" ? { outcome: "verified" } : { outcome: "unverified", reason: "verification_failure" };
}

export type WebhookEventRow = typeof webhookEvents.$inferSelect;

export interface RecordWebhookEventInput {
  paypalEventId: string;
  type: string;
  verified: boolean;
  payload: unknown;
  worldId: string | null;
}

/**
 * Stores a delivery, keyed by PayPal's event id (unique), and returns the
 * row to act on plus whether this call should process it:
 * - new id → inserted; `process` = `verified`;
 * - known id, stored unverified, now verified → upgraded in place (the
 *   verified payload and world replace a possibly forged earlier copy);
 *   `process` = true;
 * - known id, verified, not yet processed (an earlier attempt crashed or
 *   threw) → `process` = true again (every effect is idempotent);
 * - otherwise (already processed, or unverified again) → `process` = false.
 */
export async function recordWebhookEvent(
  db: Db,
  input: RecordWebhookEventInput,
): Promise<{ row: WebhookEventRow; process: boolean; duplicate: boolean }> {
  const [inserted] = await db
    .insert(webhookEvents)
    .values({
      paypalEventId: input.paypalEventId,
      type: input.type,
      verified: input.verified,
      payload: input.payload as object,
      worldId: input.worldId,
    })
    .onConflictDoNothing({ target: webhookEvents.paypalEventId })
    .returning();
  if (inserted) {
    return { row: inserted, process: input.verified, duplicate: false };
  }

  if (input.verified) {
    const [upgraded] = await db
      .update(webhookEvents)
      .set({ verified: true, type: input.type, payload: input.payload as object, worldId: input.worldId })
      .where(eq(webhookEvents.paypalEventId, input.paypalEventId))
      .returning();
    if (!upgraded) {
      throw new Error(`webhook_events row ${input.paypalEventId} vanished`);
    }
    return { row: upgraded, process: upgraded.processedAt === null, duplicate: upgraded.processedAt !== null };
  }

  const [existing] = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.paypalEventId, input.paypalEventId));
  if (!existing) {
    throw new Error(`webhook_events row ${input.paypalEventId} vanished`);
  }
  return { row: existing, process: false, duplicate: true };
}

/** The stored event with PayPal event id `paypalEventId`, or `undefined`. */
export async function getWebhookEvent(db: Db, paypalEventId: string): Promise<WebhookEventRow | undefined> {
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.paypalEventId, paypalEventId));
  return row;
}

/** Marks a stored event processed (its effects were applied, or it needed none). */
export async function markWebhookEventProcessed(db: Db, id: string): Promise<void> {
  await db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, id));
}
