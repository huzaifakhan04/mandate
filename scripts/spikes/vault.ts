/**
 * Spike: POST /v3/vault/setup-tokens for the owner's PayPal payment
 * source. Expected to likely fail with
 * NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE since vaulting isn't enabled for
 * this sandbox app (no developer.paypal.com access to toggle it).
 *
 * Run: npx tsx --env-file=.env.local scripts/spikes/vault.ts
 */
import { paypalFetch, PayPalApiError } from "@/server/paypal/fetch";
import { spikeDb, requireEnv } from "./_helpers";

async function main() {
  const baseUrl = requireEnv("PUBLIC_BASE_URL");
  const { db, worldId } = await spikeDb();

  const t0 = Date.now();
  try {
    const { body, status, operationId } = await paypalFetch(db, {
      worldId,
      kind: "vault.setup-token",
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
    console.log(JSON.stringify({ status, operationId, body, ms: Date.now() - t0 }, null, 2));
  } catch (err) {
    if (err instanceof PayPalApiError) {
      console.log(
        JSON.stringify(
          { status: err.status, name: err.name, details: err.details, ms: Date.now() - t0 },
          null,
          2,
        ),
      );
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
