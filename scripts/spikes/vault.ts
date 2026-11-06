/**
 * Spike: POST /v3/vault/setup-tokens for the owner's PayPal payment
 * source. Expected to likely fail with
 * NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE since vaulting isn't enabled for
 * this sandbox app (no developer.paypal.com access to toggle it).
 *
 * Run: npx tsx --env-file=.env.local scripts/spikes/vault.ts
 *
 * P0 artifact: a raw one-off probe of an endpoint the app never uses, so it
 * calls the pure `paypalFetch` HTTP client directly (no operation row).
 */
import { randomUUID } from "crypto";

import { paypalFetch } from "@/server/paypal/fetch";
import { requireEnv, safeJson } from "./_helpers";

async function main() {
  const baseUrl = requireEnv("PUBLIC_BASE_URL");
  const t0 = Date.now();
  // A non-2xx (e.g. 422 NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE) is returned,
  // not thrown — paypalFetch leaves interpreting it to the caller.
  const { body, httpStatus } = await paypalFetch({
    requestId: randomUUID(),
    method: "POST",
    path: "/v3/vault/setup-tokens",
    body: {
      payment_source: {
        paypal: {
          usage_type: "MERCHANT",
          customer: { id: "spike-owner" },
          experience_context: {
            return_url: `${baseUrl}/return`,
            cancel_url: `${baseUrl}/cancel`,
          },
        },
      },
    },
  });
  console.log(safeJson({ httpStatus, body, ms: Date.now() - t0 }, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
