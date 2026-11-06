/**
 * Review Focus 4 (P2 Task 3): Ed25519 request signing through `runTool`.
 * Once an agent registers a key, every mutating call must be signed by it;
 * a modified body, a skewed timestamp or a replayed signature is a 401 and
 * never executes.
 */
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/server/db/client";
import { agentKeys, agentSignatureNonces, agents, noteTransactions } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { uploadKyaDocument } from "@/server/services/kyaDocs";

import { newSigningKey, nowSeconds, signedCall } from "../../helpers/signing";
import { call, createSimWorld, createTestAgent, type Data } from "../../helpers/world";

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200, 0x20)]);

describe("Ed25519 request signing", () => {
  let db: Db;
  let worldId: string;
  let agent: { agentId: string; key: string };

  beforeEach(async () => {
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    db = await createTestDb();
    worldId = await createSimWorld(db);
    agent = await createTestAgent(db, worldId);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function register(signing = newSigningKey(), options: Parameters<typeof signedCall>[5] = {}) {
    const result = await signedCall(db, "register_public_key", agent.key, { public_key: signing.spkiB64 }, signing.privateKey, options);
    return { signing, result };
  }

  async function checkoutCount(): Promise<number> {
    return (await db.select().from(noteTransactions).where(and(eq(noteTransactions.worldId, worldId), eq(noteTransactions.kind, "buy")))).length;
  }

  it("unsigned mutating calls work while the agent has no key", async () => {
    const result = await call(db, "buy_notes", agent.key, { amount_cents: 1000 });
    expect(result.httpStatus).toBe(200);
  });

  it("register_public_key needs the request signed by the new key (proof of possession)", async () => {
    const signing = newSigningKey();
    const other = newSigningKey();
    const forged = await signedCall(db, "register_public_key", agent.key, { public_key: signing.spkiB64 }, other.privateKey);
    expect(forged.httpStatus).toBe(401);
    expect(forged.envelope.status).toBe("SIGNATURE_INVALID");

    const unsigned = await call(db, "register_public_key", agent.key, { public_key: signing.spkiB64 });
    expect(unsigned.envelope.status).toBe("SIGNATURE_REQUIRED");
    expect(await db.select().from(agentKeys)).toHaveLength(0);

    const { result } = await register(signing);
    expect(result.httpStatus).toBe(200);
    expect(result.envelope.status).toBe("OK");
    expect((result.envelope.data as Data).public_key).toBe(signing.rawB64);
  });

  it("rejects a malformed public key with INVALID_REQUEST", async () => {
    const signing = newSigningKey();
    const result = await signedCall(db, "register_public_key", agent.key, { public_key: Buffer.alloc(12).toString("base64") }, signing.privateKey);
    expect(result.httpStatus).toBe(400);
    expect(result.envelope.reason_codes).toContain("invalid_public_key");
  });

  it("after registration: a valid signature passes", async () => {
    const { signing } = await register();
    const result = await signedCall(db, "buy_notes", agent.key, { amount_cents: 1000 }, signing.privateKey);
    expect(result.httpStatus).toBe(200);
    expect(result.envelope.status).toBe("AWAITING_APPROVAL");
  });

  it("after registration: an unsigned mutating call → 401 SIGNATURE_REQUIRED (reads stay unsigned)", async () => {
    await register();
    const result = await call(db, "buy_notes", agent.key, { amount_cents: 1000 });
    expect(result.httpStatus).toBe(401);
    expect(result.envelope.status).toBe("SIGNATURE_REQUIRED");
    expect(await checkoutCount()).toBe(0);

    const status = await call(db, "get_status", agent.key, {});
    expect(status.httpStatus).toBe(200);
  });

  it("a modified body → 401 SIGNATURE_INVALID, nothing executes", async () => {
    const { signing } = await register();
    const result = await signedCall(db, "buy_notes", agent.key, { amount_cents: 5000 }, signing.privateKey, {
      signedBody: JSON.stringify({ amount_cents: 1000 }),
    });
    expect(result.httpStatus).toBe(401);
    expect(result.envelope.status).toBe("SIGNATURE_INVALID");
    expect(await checkoutCount()).toBe(0);
  });

  it("a timestamp skewed by 301 s → 401 SIGNATURE_EXPIRED", async () => {
    const { signing } = await register();
    const stale = await signedCall(db, "buy_notes", agent.key, { amount_cents: 1000 }, signing.privateKey, { timestamp: nowSeconds() - 301 });
    expect(stale.httpStatus).toBe(401);
    expect(stale.envelope.status).toBe("SIGNATURE_EXPIRED");
    const future = await signedCall(db, "buy_notes", agent.key, { amount_cents: 1000 }, signing.privateKey, { timestamp: nowSeconds() + 301 });
    expect(future.envelope.status).toBe("SIGNATURE_EXPIRED");
    expect(await checkoutCount()).toBe(0);
  });

  it("a replayed signature → 401 SIGNATURE_REPLAYED and does not execute twice", async () => {
    const { signing } = await register();
    const ts = nowSeconds();
    const first = await signedCall(db, "buy_notes", agent.key, { amount_cents: 1000 }, signing.privateKey, { timestamp: ts });
    expect(first.httpStatus).toBe(200);
    const replay = await signedCall(db, "buy_notes", agent.key, { amount_cents: 1000 }, signing.privateKey, {
      timestamp: ts,
      signature: first.signature,
    });
    expect(replay.httpStatus).toBe(401);
    expect(replay.envelope.status).toBe("SIGNATURE_REPLAYED");
    expect(await checkoutCount()).toBe(1);
  });

  it("a concurrent replay of one signed request executes once", async () => {
    const { signing } = await register();
    const ts = nowSeconds();
    const results = await Promise.all(
      [0, 1, 2].map(() => signedCall(db, "buy_notes", agent.key, { amount_cents: 1000 }, signing.privateKey, { timestamp: ts })),
    );
    expect(results.map((r) => r.envelope.status).sort()).toEqual(["AWAITING_APPROVAL", "SIGNATURE_REPLAYED", "SIGNATURE_REPLAYED"]);
    expect(await checkoutCount()).toBe(1);
  });

  it("a retry re-signs (new timestamp) and is replayed from the Idempotency-Key", async () => {
    const { signing } = await register();
    const ts = nowSeconds();
    const first = await signedCall(db, "buy_notes", agent.key, { amount_cents: 1000 }, signing.privateKey, { timestamp: ts, idempotencyKey: "k1" });
    const retry = await signedCall(db, "buy_notes", agent.key, { amount_cents: 1000 }, signing.privateKey, { timestamp: ts + 1, idempotencyKey: "k1" });
    expect(retry.envelope).toEqual(first.envelope);
    expect(await checkoutCount()).toBe(1);
  });

  it("rotation: signed by the new key AND the current key (X-Mandate-Previous-Signature); the old key is revoked", async () => {
    const { signing: oldKey } = await register();
    const newKey = newSigningKey();

    const withoutPrevious = await signedCall(db, "register_public_key", agent.key, { public_key: newKey.rawB64 }, newKey.privateKey);
    expect(withoutPrevious.httpStatus).toBe(401);
    expect(withoutPrevious.envelope.status).toBe("SIGNATURE_REQUIRED");
    expect(withoutPrevious.envelope.reason_codes).toContain("previous_signature_required");

    const wrongPrevious = await signedCall(db, "register_public_key", agent.key, { public_key: newKey.rawB64 }, newKey.privateKey, {
      previousKey: newSigningKey().privateKey,
    });
    expect(wrongPrevious.envelope.status).toBe("SIGNATURE_INVALID");

    const rotated = await signedCall(db, "register_public_key", agent.key, { public_key: newKey.rawB64 }, newKey.privateKey, {
      previousKey: oldKey.privateKey,
    });
    expect(rotated.httpStatus).toBe(200);
    expect((rotated.envelope.data as Data).rotated).toBe(true);

    const active = await db.select().from(agentKeys).where(and(eq(agentKeys.agentId, agent.agentId), isNull(agentKeys.revokedAt)));
    expect(active.map((k) => k.publicKey)).toEqual([newKey.rawB64]);

    const byOld = await signedCall(db, "buy_notes", agent.key, { amount_cents: 1000 }, oldKey.privateKey);
    expect(byOld.envelope.status).toBe("SIGNATURE_INVALID");
    const byNew = await signedCall(db, "buy_notes", agent.key, { amount_cents: 1000 }, newKey.privateKey);
    expect(byNew.httpStatus).toBe(200);
  });

  it("re-registering the active key is a no-op OK", async () => {
    const { signing } = await register();
    const again = await signedCall(db, "register_public_key", agent.key, { public_key: signing.rawB64 }, signing.privateKey);
    expect(again.httpStatus).toBe(200);
    expect((again.envelope.data as Data).rotated).toBe(false);
    expect(await db.select().from(agentKeys)).toHaveLength(1);
  });

  it("stores each accepted signature once, for replay protection", async () => {
    await register();
    const nonces = await db.select().from(agentSignatureNonces).where(eq(agentSignatureNonces.agentId, agent.agentId));
    expect(nonces).toHaveLength(1);
    expect(nonces[0]!.worldId).toBe(worldId);
  });

  it("the tier becomes T2 once a document is approved and a key is registered", async () => {
    const tierOf = async () => ((await call(db, "get_status", agent.key, {})).envelope.data as { kya: Data }).kya;
    expect(await tierOf()).toMatchObject({ tier: 1, next_tier_requirements: ["kya_document_missing", "signing_key_missing"] });

    const [owner] = await db.select({ principalId: agents.principalId }).from(agents).where(eq(agents.id, agent.agentId));
    const upload = await uploadKyaDocument(db, {
      principalId: owner!.principalId!,
      agentId: agent.agentId,
      kind: "operator_registration",
      fileName: "registration.pdf",
      bytes: PDF,
    });
    expect(upload).toMatchObject({ outcome: "uploaded", document: { reviewStatus: "approved" } });
    expect(await tierOf()).toMatchObject({ tier: 1, next_tier_requirements: ["signing_key_missing"] });

    await register();
    expect(await tierOf()).toMatchObject({ tier: 2, next_tier_requirements: [] });
  });
});

