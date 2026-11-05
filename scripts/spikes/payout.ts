/**
 * Spike: $1.00 PayPal Payout to PAYPAL_OWNER_EMAIL, then poll batch
 * status 10x at 3s intervals to see PENDING -> SUCCESS timing.
 *
 * Run: npx tsx --env-file=.env.local scripts/spikes/payout.ts
 */
import { randomUUID } from "crypto";

import { paypalRail } from "@/server/rail/paypalRail";
import { spikeDb, requireEnv, safeJson } from "./_helpers";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const owner = requireEnv("PAYPAL_OWNER_EMAIL");
  const { db, worldId } = await spikeDb();

  const t0 = Date.now();
  const rail = paypalRail(db);
  const sent = await rail.sendPayout({
    worldId,
    purpose: "note_redemption",
    sourceId: `spike-${randomUUID()}`,
    receiver: owner,
    receiverType: "EMAIL",
    amountCents: 100n,
    note: "Spike payout",
    senderItemId: `spike-${randomUUID()}`,
  });
  console.log("send:", safeJson(sent), `(${Date.now() - t0}ms)`);

  const log: { t: number; status: string }[] = [];
  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    const got = await rail.getPayout({ worldId, batchId: sent.batchId });
    log.push({ t: Date.now() - t0, status: got.batchStatus });
    console.log(`poll ${i + 1}: t=${Date.now() - t0}ms status=${got.batchStatus}`, safeJson(got.items));
  }

  console.log(safeJson({ sent, pollLog: log }, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
