import { getDb } from "@/server/db/client";
import { createPayPalWebhookHandler } from "@/server/jobs/webhookHandler";

/**
 * PayPal webhooks (Task 8): verified with PayPal's verify-webhook-signature
 * postback, stored in `webhook_events` (one row per event id), then
 * dispatched to the payout appliers / checkout settlement. See
 * `src/server/jobs/webhookHandler.ts`.
 */
export const maxDuration = 30;

export const { POST } = createPayPalWebhookHandler({ getDb });
