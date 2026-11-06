/**
 * Ed25519 request-signing helpers for tests (P2 Task 3): a fresh key pair,
 * the `X-Mandate-*` headers for a request, and a signed `runTool` call
 * shaped exactly like the REST route builds it.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from "crypto";

import "@/server/contracts/tools";
import { findTool } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import type { Db } from "@/server/db/client";

export interface TestSigningKey {
  privateKey: KeyObject;
  /** SPKI DER, base64. */
  spkiB64: string;
  /** The raw 32-byte public key, base64. */
  rawB64: string;
}

export function newSigningKey(): TestSigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return { privateKey, spkiB64: spki.toString("base64"), rawB64: spki.subarray(spki.length - 32).toString("base64") };
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** base64 Ed25519 signature over `${timestamp}\n${METHOD}\n${path}\n${sha256hex(body)}`. */
export function signRequest(privateKey: KeyObject, timestamp: number | string, method: string, path: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return sign(null, Buffer.from(`${timestamp}\n${method.toUpperCase()}\n${path}\n${bodyHash}`), privateKey).toString("base64");
}

export interface SignedCallOptions {
  /** Unix seconds; defaults to now. */
  timestamp?: number;
  /** Sign this body instead of the one actually sent (to forge a mismatch). */
  signedBody?: string;
  /** Also sign with this (current) key as `X-Mandate-Previous-Signature` (key rotation). */
  previousKey?: KeyObject;
  idempotencyKey?: string | null;
  /** Reuse an exact signature (replay). */
  signature?: string;
}

/** A `runTool` call carrying the signed-request facts the REST route threads through. */
export async function signedCall(
  db: Db,
  toolName: string,
  apiKey: string,
  input: Record<string, unknown>,
  privateKey: KeyObject,
  options: SignedCallOptions = {},
) {
  const path = `/api/v1/${toolName}`;
  const rawBody = JSON.stringify(input);
  const timestamp = options.timestamp ?? nowSeconds();
  const signedBody = options.signedBody ?? rawBody;
  const signature = options.signature ?? signRequest(privateKey, timestamp, "POST", path, signedBody);
  const previousSignature = options.previousKey
    ? signRequest(options.previousKey, timestamp, "POST", path, signedBody)
    : null;
  const result = await runTool(findTool(toolName), toolName, JSON.parse(rawBody), {
    getDb: async () => db,
    authorization: `Bearer ${apiKey}`,
    idempotencyKey: options.idempotencyKey ?? null,
    request: {
      method: "POST",
      path,
      rawBody,
      timestamp: String(timestamp),
      signature,
      previousSignature,
    },
  });
  return { ...result, signature };
}
