/**
 * Spike: OAuth token + order create against PayPal sandbox. Confirms we
 * can mint an access token and create a CAPTURE order with an
 * approve/payer-action link. Uses an in-memory PGlite db (never Neon).
 *
 * Run: npx tsx --env-file=.env.local scripts/spikes/token-and-order.ts
 */
import * as orders from "@/server/paypal/orders";
import { spikeDb, requireEnv, safeJson } from "./_helpers";

async function main() {
  const baseUrl = requireEnv("PUBLIC_BASE_URL");
  const { db, worldId } = await spikeDb();

  const started = Date.now();
  const result = await orders.create(db, {
    worldId,
    amountCents: 500n,
    description: "Spike: token-and-order",
    customId: "spike-token-and-order",
    returnUrl: `${baseUrl}/return`,
    cancelUrl: `${baseUrl}/cancel`,
  });
  const ms = Date.now() - started;

  console.log(safeJson({ ...result, ms }, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
