import { randomUUID } from "crypto";

import { createTestDb } from "@/server/db/testing";
import { worlds } from "@/server/db/schema";
import type { Db } from "@/server/db/client";

/**
 * Spin up an in-memory PGlite db with every migration applied and one
 * `worlds` row, for day-1 PayPal spike scripts. Never touches the real
 * Neon database, so spikes don't pollute production `paypal_operations`
 * rows.
 */
export async function spikeDb(): Promise<{ db: Db; worldId: string }> {
  const db = await createTestDb();
  const [world] = await db
    .insert(worlds)
    .values({ slug: `spike-${randomUUID()}`, name: "Spike", railMode: "paypal" })
    .returning();
  if (!world) {
    throw new Error("expected a world to be inserted");
  }
  return { db, worldId: world.id };
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

/**
 * `JSON.stringify`, but safe for values returned by the rail layer that
 * carry `bigint` fields (e.g. `CaptureOrderResult.amountCents`) —
 * `JSON.stringify` throws "Do not know how to serialize a BigInt" on
 * those otherwise. Bigints are rendered as plain decimal strings.
 */
export function safeJson(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_key, val) => (typeof val === "bigint" ? val.toString() : val),
    space,
  );
}

/**
 * Optional CLI arg selecting which sandbox personal account to act as,
 * e.g. `npx tsx scripts/spikes/payee-routing.ts lender`. Falls back to
 * `client`. Used by spikes that drive a Playwright buyer login, so the
 * account can be swapped without editing the script (e.g. when one
 * account is temporarily rate-limited by PayPal's sandbox login).
 */
export function payerAccountFromArgv(fallback: "client" | "lender" | "owner" = "client"): "client" | "lender" | "owner" {
  const arg = process.argv[2]?.toLowerCase();
  if (arg === "client" || arg === "lender" || arg === "owner") {
    return arg;
  }
  return fallback;
}
