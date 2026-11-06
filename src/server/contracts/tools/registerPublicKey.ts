import { createHash } from "crypto";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { parsePublicKey } from "../../auth/signatures";
import { agents } from "../../db/schema";
import { registerAgentKey } from "../../auth/agentKeys";
import { loadAgentKya } from "../../services/kya";
import { fail, ok } from "../envelope";
import { defineTool } from "../registry";

const inputSchema = z.object({
  public_key: z
    .string()
    .min(1)
    .max(512)
    .describe("Your Ed25519 public key, base64: the raw 32 bytes or the SPKI DER encoding."),
});

const outputSchema = z.object({
  key_id: z.string(),
  alg: z.literal("ed25519"),
  public_key: z.string(),
  fingerprint: z.string(),
  rotated: z.boolean(),
  kya: z.object({ tier: z.number(), next_tier_requirements: z.array(z.string()) }),
});

/**
 * P2 Task 3. `runTool`'s signature gate has already checked, before this
 * runs, that the request is signed by `public_key` (proof of possession)
 * and — when rotating — by the current key too.
 */
export const registerPublicKeyTool = defineTool({
  name: "register_public_key",
  title: "Register Public Key",
  description:
    "Registers the calling agent's Ed25519 request-signing key (optional; together with an approved KYA " +
    "document it unlocks KYA tier T2). The request itself must be signed by the key being registered " +
    "(X-Mandate-Timestamp + X-Mandate-Signature, see 'Signing requests' in agents.md). Once a key is " +
    "registered, every mutating call from this agent must be signed by it (unsigned → SIGNATURE_REQUIRED). " +
    "Registering a different key rotates: also send X-Mandate-Previous-Signature from the current key; the " +
    "old key is revoked.",
  auth: "agent",
  mutating: true,
  readOnly: false,
  input: inputSchema,
  output: outputSchema,
  signingKeyFromInput: (input) => input.public_key,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("register_public_key requires an authenticated agent");
    }
    const parsed = parsePublicKey(input.public_key);
    if (!parsed.ok) {
      return fail("INVALID_REQUEST", "public_key must be a base64 Ed25519 public key.", ["invalid_public_key", parsed.reason]);
    }

    // Serialise concurrent registrations for this agent.
    await ctx.scoped.forUpdate(agents, eq(agents.id, ctx.agentId));
    const { key, rotated } = await registerAgentKey(ctx.tx, ctx.worldId, ctx.agentId, parsed.rawB64);
    const { tier } = await loadAgentKya(ctx.tx, ctx.worldId, ctx.agentId);
    const fingerprint = createHash("sha256").update(Buffer.from(parsed.rawB64, "base64")).digest("hex").slice(0, 16);

    return ok(
      {
        key_id: key.id,
        alg: "ed25519" as const,
        public_key: parsed.rawB64,
        fingerprint,
        rotated,
        kya: { tier: tier.tier, next_tier_requirements: tier.nextTierRequirements },
      },
      {
        status: "OK",
        summary: rotated
          ? "Signing key rotated; the previous key is revoked. Sign every mutating request with the new key."
          : "Signing key registered. Sign every mutating request with it from now on.",
        next_actions: [{ tool: "get_status", args: {} }],
      },
    );
  },
});
