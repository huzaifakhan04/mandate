import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

import { REVEAL_COOKIE_NAME, REVEAL_COOKIE_PATH } from "./revealCookie";
import { sessionSecret } from "./session";

/**
 * One-time API key reveal (P2 Task 5). A new agent's key (path B) or a
 * rotated key is shown to its owner exactly once, on
 * `/dashboard/agents/<id>/api-key`. The owner route that made the key
 * 303s there carrying it in the `mandate_reveal` cookie:
 *
 * - AES-256-GCM encrypted under a key derived from `SESSION_SECRET`, so
 *   the plaintext key never sits in the browser's cookie jar or a log;
 * - bound to the principal and the agent, and valid for 10 minutes;
 * - HttpOnly, SameSite=Strict, Path=/dashboard/agents;
 * - moved into a request header and cleared by `src/proxy.ts` on the
 *   response to the page that shows it, so a reload finds nothing to show.
 */

export { REVEAL_COOKIE_NAME, REVEAL_COOKIE_PATH, REVEAL_HEADER_NAME } from "./revealCookie";
export const REVEAL_TTL_SECONDS = 10 * 60;

export type RevealKind = "registered" | "rotated";

export interface Reveal {
  principalId: string;
  agentId: string;
  apiKey: string;
  kind: RevealKind;
}

function revealKey(): Buffer {
  return createHash("sha256").update(`mandate-reveal:v1\n${sessionSecret()}`).digest();
}

/** The sealed cookie value for `reveal`, valid for `REVEAL_TTL_SECONDS` from `now`. */
export function sealReveal(reveal: Reveal, now: Date = new Date()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", revealKey(), iv);
  const plaintext = JSON.stringify({
    p: reveal.principalId,
    a: reveal.agentId,
    k: reveal.apiKey,
    t: reveal.kind,
    exp: Math.floor(now.getTime() / 1000) + REVEAL_TTL_SECONDS,
  });
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/**
 * The reveal in `value` if it decrypts, is unexpired and belongs to
 * `principalId` + `agentId`; otherwise `null`.
 */
export function openReveal(
  value: string | null | undefined,
  expect: { principalId: string; agentId: string },
  now: Date = new Date(),
): Reveal | null {
  if (!value) {
    return null;
  }
  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.length < 29) {
      return null;
    }
    const decipher = createDecipheriv("aes-256-gcm", revealKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plaintext) as { p?: unknown; a?: unknown; k?: unknown; t?: unknown; exp?: unknown };
    if (
      parsed.p !== expect.principalId ||
      parsed.a !== expect.agentId ||
      typeof parsed.k !== "string" ||
      (parsed.t !== "registered" && parsed.t !== "rotated") ||
      typeof parsed.exp !== "number" ||
      parsed.exp * 1000 <= now.getTime()
    ) {
      return null;
    }
    return { principalId: parsed.p, agentId: parsed.a, apiKey: parsed.k, kind: parsed.t };
  } catch {
    return null;
  }
}

/** The `Set-Cookie` header carrying `sealed`. */
export function revealCookieHeader(sealed: string): string {
  const parts = [
    `${REVEAL_COOKIE_NAME}=${sealed}`,
    `Path=${REVEAL_COOKIE_PATH}`,
    `Max-Age=${REVEAL_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}
