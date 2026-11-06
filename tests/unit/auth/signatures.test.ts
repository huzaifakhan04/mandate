import { generateKeyPairSync } from "crypto";

import { describe, expect, it } from "vitest";

import {
  SIGNATURE_WINDOW_SECONDS,
  canonicalRequestString,
  checkRequestSignature,
  parsePublicKey,
} from "@/server/auth/signatures";

import { newSigningKey, signRequest } from "../../helpers/signing";

const NOW = new Date("2026-11-06T12:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

function request(key: ReturnType<typeof newSigningKey>, overrides: Partial<{ ts: number; body: string; signedBody: string; path: string; method: string }> = {}) {
  const ts = overrides.ts ?? NOW_S;
  const body = overrides.body ?? '{"amount_cents":1000}';
  const path = overrides.path ?? "/api/v1/buy_notes";
  return {
    method: overrides.method ?? "POST",
    path,
    rawBody: body,
    timestamp: String(ts),
    signature: signRequest(key.privateKey, ts, "POST", "/api/v1/buy_notes", overrides.signedBody ?? body),
    previousSignature: null,
  };
}

describe("parsePublicKey", () => {
  it("accepts a raw 32-byte key and an SPKI DER key, normalising both to raw base64", () => {
    const key = newSigningKey();
    expect(parsePublicKey(key.rawB64)).toEqual({ ok: true, rawB64: key.rawB64 });
    expect(parsePublicKey(key.spkiB64)).toEqual({ ok: true, rawB64: key.rawB64 });
  });

  it("rejects garbage, wrong lengths and non-Ed25519 SPKI keys", () => {
    expect(parsePublicKey("not base64 !!").ok).toBe(false);
    expect(parsePublicKey(Buffer.alloc(31).toString("base64")).ok).toBe(false);
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(parsePublicKey(publicKey.export({ format: "der", type: "spki" }).toString("base64")).ok).toBe(false);
  });
});

describe("checkRequestSignature", () => {
  it("builds the canonical string from timestamp, method, path and the body's sha256", () => {
    expect(canonicalRequestString("1700000000", "post", "/api/v1/x", "")).toBe(
      "1700000000\nPOST\n/api/v1/x\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("a valid signature passes", () => {
    const key = newSigningKey();
    expect(checkRequestSignature(request(key), key.rawB64, NOW)).toEqual({ ok: true, signatureB64: expect.any(String) });
  });

  it("a modified body → SIGNATURE_INVALID", () => {
    const key = newSigningKey();
    const result = checkRequestSignature(request(key, { body: '{"amount_cents":9000}', signedBody: '{"amount_cents":1000}' }), key.rawB64, NOW);
    expect(result).toMatchObject({ ok: false, status: "SIGNATURE_INVALID" });
  });

  it("another key's signature, or a different path, → SIGNATURE_INVALID", () => {
    const key = newSigningKey();
    const other = newSigningKey();
    expect(checkRequestSignature(request(key), other.rawB64, NOW)).toMatchObject({ ok: false, status: "SIGNATURE_INVALID" });
    expect(checkRequestSignature(request(key, { path: "/api/v1/redeem_notes" }), key.rawB64, NOW)).toMatchObject({
      ok: false,
      status: "SIGNATURE_INVALID",
    });
  });

  it("a timestamp 300 s off is accepted; 301 s (either way) → SIGNATURE_EXPIRED", () => {
    const key = newSigningKey();
    expect(SIGNATURE_WINDOW_SECONDS).toBe(300);
    expect(checkRequestSignature(request(key, { ts: NOW_S - 300 }), key.rawB64, NOW).ok).toBe(true);
    expect(checkRequestSignature(request(key, { ts: NOW_S + 300 }), key.rawB64, NOW).ok).toBe(true);
    expect(checkRequestSignature(request(key, { ts: NOW_S - 301 }), key.rawB64, NOW)).toMatchObject({ ok: false, status: "SIGNATURE_EXPIRED" });
    expect(checkRequestSignature(request(key, { ts: NOW_S + 301 }), key.rawB64, NOW)).toMatchObject({ ok: false, status: "SIGNATURE_EXPIRED" });
  });

  it("missing headers → SIGNATURE_REQUIRED; a malformed timestamp or signature → SIGNATURE_INVALID", () => {
    const key = newSigningKey();
    expect(checkRequestSignature({ ...request(key), signature: null }, key.rawB64, NOW)).toMatchObject({ status: "SIGNATURE_REQUIRED" });
    expect(checkRequestSignature({ ...request(key), timestamp: null }, key.rawB64, NOW)).toMatchObject({ status: "SIGNATURE_REQUIRED" });
    expect(checkRequestSignature(null, key.rawB64, NOW)).toMatchObject({ status: "SIGNATURE_REQUIRED" });
    expect(checkRequestSignature({ ...request(key), timestamp: "12.5" }, key.rawB64, NOW)).toMatchObject({ status: "SIGNATURE_INVALID" });
    expect(checkRequestSignature({ ...request(key), signature: "AAAA" }, key.rawB64, NOW)).toMatchObject({ status: "SIGNATURE_INVALID" });
  });

  it("normalises base64url signatures to standard base64 (one replay key per signature)", () => {
    const key = newSigningKey();
    const req = request(key);
    const urlSafe = Buffer.from(req.signature, "base64").toString("base64url");
    const a = checkRequestSignature(req, key.rawB64, NOW);
    const b = checkRequestSignature({ ...req, signature: urlSafe }, key.rawB64, NOW);
    expect(a.ok && b.ok && a.signatureB64 === b.signatureB64).toBe(true);
  });
});
