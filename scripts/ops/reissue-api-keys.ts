/**
 * Re-key agents after an API_KEY_PEPPER rotation (ops).
 *
 *   npx tsx --env-file=.env.local scripts/ops/reissue-api-keys.ts --before <ISO> [--apply] [--out <file>]
 *
 * Every non-revoked `api_keys` row created before `--before` was hashed
 * with the old pepper and can no longer verify. For each one, in a single
 * transaction: revoke it, insert a fresh key for the same agent with the
 * same scope (hashed with the CURRENT API_KEY_PEPPER), and append an
 * `agent.api_key_rotated` event (`by: "operator"`) — the same steps as the
 * owner's dashboard rotation (`rotateApiKey`), which needs a claimed agent.
 *
 * Without `--apply` it only lists what it would re-key (no writes). With
 * `--apply` the new full keys are written to `--out` (default
 * ~/.mandate-reissued-keys.txt, mode 600) and never printed.
 */
import { chmodSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { and, eq, isNull, lt } from "drizzle-orm";

import { generateApiKey } from "@/server/auth/apiKeys";
import { getSimNow } from "@/server/clock/clock";
import { getDb } from "@/server/db/client";
import { agents, apiKeys, events, worlds } from "@/server/db/schema";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const beforeRaw = arg("--before");
  const before = beforeRaw ? new Date(beforeRaw) : null;
  if (!before || Number.isNaN(before.getTime())) {
    throw new Error("--before <ISO timestamp> is required (keys created before it are re-keyed).");
  }
  if (!process.env.DATABASE_URL || !process.env.API_KEY_PEPPER) {
    throw new Error("DATABASE_URL and API_KEY_PEPPER must be set (run with --env-file=.env.local).");
  }
  const apply = process.argv.includes("--apply");
  const out = arg("--out") ?? join(homedir(), ".mandate-reissued-keys.txt");
  const db = await getDb();

  const stale = await db
    .select({
      keyId: apiKeys.id,
      prefix: apiKeys.prefix,
      scope: apiKeys.scope,
      worldId: apiKeys.worldId,
      agentId: agents.id,
      name: agents.name,
      status: agents.status,
      worldKind: worlds.kind,
    })
    .from(apiKeys)
    .innerJoin(agents, eq(apiKeys.agentId, agents.id))
    .innerJoin(worlds, eq(apiKeys.worldId, worlds.id))
    .where(and(isNull(apiKeys.revokedAt), lt(apiKeys.createdAt, before)))
    .orderBy(apiKeys.createdAt);

  console.log(`${stale.length} non-revoked key(s) created before ${before.toISOString()}${apply ? "" : " (dry run)"}:`);
  for (const k of stale) {
    console.log(`  ${k.worldKind.padEnd(8)} ${k.name.padEnd(22)} ${k.status.padEnd(10)} agent=${k.agentId} old_prefix=${k.prefix} scope=${k.scope}`);
  }
  if (!apply || stale.length === 0) {
    return;
  }

  const now = new Date();
  const issued: string[] = [];
  await db.transaction(async (tx) => {
    for (const k of stale) {
      await tx.update(apiKeys).set({ revokedAt: now }).where(eq(apiKeys.id, k.keyId));
      const generated = generateApiKey();
      await tx.insert(apiKeys).values({
        worldId: k.worldId,
        agentId: k.agentId,
        prefix: generated.prefix,
        keyHash: generated.hash,
        scope: k.scope,
        createdAt: now,
      });
      await tx.insert(events).values({
        worldId: k.worldId,
        type: "agent.api_key_rotated",
        aggregateType: "agent",
        aggregateId: k.agentId,
        payload: {
          agent_id: k.agentId,
          by: "operator",
          reason: "api_key_pepper_rotation",
          revoked_prefixes: [k.prefix],
          prefix: generated.prefix,
          scope: k.scope,
        },
        occurredSimAt: await getSimNow(tx, k.worldId),
      });
      issued.push(`${k.worldKind}\t${k.name}\t${k.status}\tagent=${k.agentId}\told_prefix=${k.prefix}\t${generated.key}`);
    }
  });

  writeFileSync(out, `# Re-issued ${now.toISOString()} (world, agent, status, id, old prefix, NEW API KEY)\n${issued.join("\n")}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`re-keyed ${issued.length} agent key(s); new keys written to ${out} (mode 600)`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
