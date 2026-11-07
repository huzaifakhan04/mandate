/**
 * P7 Risk Desk — admin: clear one risk flag (the main world's only way to
 * clear a flag early; owners can request a review from the dashboard).
 *
 *   npx tsx --env-file=.env.local scripts/elastic/clear-flag.ts <world_id> <flag_id>
 *
 * Prints the outcome only (`cleared`, `not_open`, `not_found`).
 */
import { getDb } from "../../src/server/db/client";
import { clearRiskFlag } from "../../src/server/services/riskFlags";

async function main(): Promise<void> {
  const [worldId, flagId] = process.argv.slice(2);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!worldId || !flagId || !uuid.test(worldId) || !uuid.test(flagId)) {
    throw new Error("usage: clear-flag.ts <world_id> <flag_id>");
  }
  const outcome = await clearRiskFlag(await getDb(), { by: "admin", worldId, flagId });
  console.log(outcome);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`clear-flag failed: ${err instanceof Error ? err.message.split("\n")[0] : "unknown error"}`);
    process.exit(1);
  },
);
