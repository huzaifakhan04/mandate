import { createHash, createPublicKey, verify, type KeyObject } from "crypto";

/**
 * Ed25519 request signing (P2 Task 3, Global Constraints "Ed25519
 * signing"). Pure crypto + header parsing; the key and nonce tables live
 * in `services/agentKeys.ts`, and `runTool` wires the two together.
 *
 * An agent signs
 *
 *     `${timestamp}\n${METHOD}\n${path}\n${sha256hex(rawBody)}`
 *
 * with its Ed25519 key and sends `X-Mandate-Timestamp` (unix seconds) and
 * `X-Mandate-Signature` (base64). The timestamp must be within ±300 s of
 * the server's clock. Over MCP the request is `POST /api/mcp/mcp` and the
 * body is the raw JSON-RPC request body.
 */

export const TIMESTAMP_HEADER = "x-mandate-timestamp";
export const SIGNATURE_HEADER = "x-mandate-signature";
/** Key rotation only: the CURRENT key's signature over the same canonical string. */
export const PREVIOUS_SIGNATURE_HEADER = "x-mandate-previous-signature";

export const SIGNATURE_WINDOW_SECONDS = 300;
/** How long a seen signature must be remembered: the whole ±300 s window. */
export const NONCE_RETENTION_MS = 2 * SIGNATURE_WINDOW_SECONDS * 1000;

/** The request facts a signature covers, threaded from the REST/MCP route into `runTool`. */
export interface SignedRequest {
  method: string;
  path: string;
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  /** `X-Mandate-Previous-Signature` (key rotation), or `null`. */
  previousSignature: string | null;
}

export type SignatureFailureStatus = "SIGNATURE_REQUIRED" | "SIGNATURE_INVALID" | "SIGNATURE_EXPIRED";

export type SignatureCheck =
  | { ok: true; /** The signature re-encoded as standard base64 (the replay key). */ signatureB64: string }
  | { ok: false; status: SignatureFailureStatus; reason: string };

/** Builds a `SignedRequest` from incoming headers. */
export function signedRequestFrom(headers: Headers, method: string, path: string, rawBody: string): SignedRequest {
  return {
    method,
    path,
    rawBody,
    timestamp: headers.get(TIMESTAMP_HEADER),
    signature: headers.get(SIGNATURE_HEADER),
    previousSignature: headers.get(PREVIOUS_SIGNATURE_HEADER),
  };
}

export function canonicalRequestString(timestamp: string, method: string, path: string, rawBody: string): string {
  const bodyHash = createHash("sha256").update(rawBody, "utf8").digest("hex");
  return `${timestamp}\n${method.toUpperCase()}\n${path}\n${bodyHash}`;
}

const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Strict-ish base64/base64url decode: `null` for anything that isn't. */
function decodeBase64(value: string): Buffer | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !BASE64_RE.test(trimmed)) {
    return null;
  }
  return Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// SPKI DER prefix of an Ed25519 public key (RFC 8410): SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING }.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function keyObjectFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export type ParsedPublicKey = { ok: true; rawB64: string } | { ok: false; reason: string };

/**
 * Accepts a base64 raw 32-byte Ed25519 public key or a base64 SPKI DER
 * one, and returns the canonical form we store: the raw key, base64.
 */
export function parsePublicKey(value: string): ParsedPublicKey {
  const bytes = decodeBase64(value);
  if (!bytes) {
    return { ok: false, reason: "not_base64" };
  }
  let raw: Buffer;
  if (bytes.length === 32) {
    raw = bytes;
  } else {
    try {
      const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
      if (key.asymmetricKeyType !== "ed25519") {
        return { ok: false, reason: "not_ed25519" };
      }
      const der = key.export({ format: "der", type: "spki" });
      raw = der.subarray(der.length - 32);
    } catch {
      return { ok: false, reason: "not_a_public_key" };
    }
  }
  try {
    keyObjectFromRaw(raw);
  } catch {
    return { ok: false, reason: "not_a_public_key" };
  }
  return { ok: true, rawB64: raw.toString("base64") };
}

const TIMESTAMP_RE = /^\d{1,12}$/;

/**
 * Checks `request`'s timestamp and `X-Mandate-Signature` (or, with
 * `field: "previousSignature"`, `X-Mandate-Previous-Signature`) against
 * the raw base64 Ed25519 key `publicKeyB64`, at real time `now`. Does
 * not check for replay — the caller records `signatureB64` as a nonce.
 */
export function checkRequestSignature(
  request: SignedRequest | null,
  publicKeyB64: string,
  now: Date = new Date(),
  field: "signature" | "previousSignature" = "signature",
): SignatureCheck {
  const signatureHeader = request?.[field] ?? null;
  if (!request || !request.timestamp || !signatureHeader) {
    return {
      ok: false,
      status: "SIGNATURE_REQUIRED",
      reason: field === "signature" ? "signature_required" : "previous_signature_required",
    };
  }
  if (!TIMESTAMP_RE.test(request.timestamp.trim())) {
    return { ok: false, status: "SIGNATURE_INVALID", reason: "timestamp_malformed" };
  }
  const signature = decodeBase64(signatureHeader);
  if (!signature || signature.length !== 64) {
    return { ok: false, status: "SIGNATURE_INVALID", reason: "signature_malformed" };
  }
  const timestamp = request.timestamp.trim();
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp));
  if (skew > SIGNATURE_WINDOW_SECONDS) {
    return { ok: false, status: "SIGNATURE_EXPIRED", reason: "timestamp_out_of_window" };
  }
  const message = Buffer.from(canonicalRequestString(timestamp, request.method, request.path, request.rawBody), "utf8");
  let valid = false;
  try {
    valid = verify(null, message, keyObjectFromRaw(Buffer.from(publicKeyB64, "base64")), signature);
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, status: "SIGNATURE_INVALID", reason: field === "signature" ? "signature_mismatch" : "previous_signature_mismatch" };
  }
  return { ok: true, signatureB64: signature.toString("base64") };
}
