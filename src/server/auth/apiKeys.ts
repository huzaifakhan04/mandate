import { createHash, randomBytes, timingSafeEqual } from "crypto";

import { eq } from "drizzle-orm";

import type { Db } from "../db/client";
import { agents, apiKeys } from "../db/schema";

/** RFC 4648 base32 alphabet, lowercased, no padding. */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** `mnd_<8 lowercase-base32 chars>_<32 lowercase-base32 chars>`. */
export const API_KEY_PATTERN = /^mnd_([a-z2-7]{8})_([a-z2-7]{32})$/;

/**
 * The authenticated agent a request is acting as. Resolved from an API key
 * by `verifyApiKey`; `null` means the request is unauthenticated (only
 * valid for `auth: 'none'` tools).
 */
export interface AgentPrincipal {
  agentId: string;
  worldId: string;
  status: string;
  /** P8: the presenting key's scope; absent (bots, older callers) = `full`. */
  scope?: ApiKeyScope;
}

/** P8: `full`, or `read_only` (readOnly tools only — `FORBIDDEN_SCOPE` otherwise). */
export type ApiKeyScope = "full" | "read_only";

export interface GeneratedApiKey {
  /** The full key to hand to the agent once; never stored. */
  key: string;
  /** The public lookup prefix, stored in `api_keys.prefix`. */
  prefix: string;
  /** `sha256(API_KEY_PEPPER + secret)` hex digest, stored in `api_keys.key_hash`. */
  hash: string;
}

/**
 * Draws `length` cryptographically random base32 characters. 256 (the
 * range of a byte) is an exact multiple of 32, so `byte % 32` introduces no
 * modulo bias.
 */
function randomBase32(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += BASE32_ALPHABET[bytes[i]! % 32];
  }
  return out;
}

/**
 * Hashes a key's secret half with the server-side pepper
 * (`API_KEY_PEPPER`), so a stolen `key_hash` row is useless without it.
 * Throws if the pepper is not configured — this must never silently hash
 * with an empty/missing pepper.
 */
export function hashSecret(secret: string): string {
  const pepper = process.env.API_KEY_PEPPER;
  if (!pepper) {
    throw new Error(
      "API_KEY_PEPPER is not set. Set it in the environment (tests use a " +
        "fixed test-only pepper) before generating or verifying API keys.",
    );
  }
  return createHash("sha256").update(pepper + secret).digest("hex");
}

/**
 * Generates a fresh agent API key: `mnd_<prefix8>_<secret32>` (lowercase
 * base32). Returns the full key (to hand to the agent once), the prefix
 * (the public lookup column), and the secret's hash (what actually gets
 * stored in `api_keys.key_hash` — the full key, and the bare secret, are
 * never persisted).
 */
export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBase32(8);
  const secret = randomBase32(32);
  const key = `mnd_${prefix}_${secret}`;
  const hash = hashSecret(secret);
  return { key, prefix, hash };
}

/**
 * Verifies a presented API key against `api_keys`/`agents`:
 * - malformed key (doesn't match `API_KEY_PATTERN`) → `null`.
 * - unknown prefix → `null`.
 * - hash mismatch (tampered/wrong secret) → `null`, in constant time.
 * - `revoked_at` set → `null`.
 * - otherwise: stamps `last_used_at` and returns the agent principal.
 */
export async function verifyApiKey(
  db: Db,
  key: string,
): Promise<AgentPrincipal | null> {
  const match = API_KEY_PATTERN.exec(key);
  if (!match) {
    return null;
  }
  const [, prefix, secret] = match;

  const rows = await db
    .select({
      id: apiKeys.id,
      agentId: apiKeys.agentId,
      worldId: apiKeys.worldId,
      keyHash: apiKeys.keyHash,
      revokedAt: apiKeys.revokedAt,
      scope: apiKeys.scope,
      agentStatus: agents.status,
    })
    .from(apiKeys)
    .innerJoin(agents, eq(apiKeys.agentId, agents.id))
    .where(eq(apiKeys.prefix, prefix!))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }

  const expected = Buffer.from(row.keyHash, "hex");
  const candidate = Buffer.from(hashSecret(secret!), "hex");
  const hashesMatch =
    expected.length === candidate.length && timingSafeEqual(expected, candidate);
  if (!hashesMatch) {
    return null;
  }

  if (row.revokedAt) {
    return null;
  }

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));

  return {
    agentId: row.agentId,
    worldId: row.worldId,
    status: row.agentStatus,
    scope: row.scope === "read_only" ? "read_only" : "full",
  };
}
