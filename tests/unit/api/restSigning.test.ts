/**
 * P2 Task 3: the REST route threads method, path and the exact raw body
 * into `runTool`, so a signature made over what the agent sent verifies,
 * and a body re-serialised differently (same JSON value) does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRestHandler } from "@/app/api/v1/[tool]/route";
import "@/server/contracts/tools";
import type { Db } from "@/server/db/client";
import { createTestDb } from "@/server/db/testing";

import { newSigningKey, nowSeconds, signRequest } from "../../helpers/signing";
import { call, type Data } from "../../helpers/world";

const ORIGIN = "https://mandate.test";

function params(tool: string) {
  return { params: Promise.resolve({ tool }) };
}

describe("REST signed requests", () => {
  let db: Db;
  let apiKey: string;

  beforeEach(async () => {
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    db = await createTestDb();
    const registered = await call(db, "register_agent", "", { name: "Signer", payout_email: "s@example.com" });
    apiKey = (registered.envelope.data as Data).api_key as string;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function post(tool: string, body: string, headers: Record<string, string>) {
    const { POST } = createRestHandler({ getDb: async () => db });
    return POST(
      new Request(`${ORIGIN}/api/v1/${tool}`, {
        method: "POST",
        body,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...headers },
      }),
      params(tool),
    );
  }

  function signed(key: ReturnType<typeof newSigningKey>, tool: string, body: string, signedBody = body) {
    const ts = nowSeconds();
    return {
      "x-mandate-timestamp": String(ts),
      "x-mandate-signature": signRequest(key.privateKey, ts, "POST", `/api/v1/${tool}`, signedBody),
    };
  }

  it("registers a key over REST with a signature over the exact body bytes", async () => {
    const key = newSigningKey();
    const body = `{ "public_key" : "${key.spkiB64}" }`;
    const res = await post("register_public_key", body, signed(key, "register_public_key", body));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("OK");
  });

  it("a signature over a re-serialised body (same JSON value) fails", async () => {
    const key = newSigningKey();
    const body = `{ "public_key" : "${key.spkiB64}" }`;
    const res = await post("register_public_key", body, signed(key, "register_public_key", body, JSON.stringify(JSON.parse(body))));
    expect(res.status).toBe(401);
    expect((await res.json()).status).toBe("SIGNATURE_INVALID");
  });

  it("after registration an unsigned REST mutating call → 401 SIGNATURE_REQUIRED", async () => {
    const key = newSigningKey();
    const body = JSON.stringify({ public_key: key.rawB64 });
    expect((await post("register_public_key", body, signed(key, "register_public_key", body))).status).toBe(200);
    const res = await post("redeem_notes", JSON.stringify({ amount_cents: 1000 }), {});
    expect(res.status).toBe(401);
    expect((await res.json()).status).toBe("SIGNATURE_REQUIRED");
  });
});
