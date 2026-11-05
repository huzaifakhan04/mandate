import { describe, expect, it } from "vitest";

import { redact } from "@/server/paypal/redact";

describe("redact", () => {
  it("masks a key matching /token|secret|password|authorization/i regardless of value type", () => {
    const result = redact({
      access_token: "A21AAHxyz",
      clientSecret: "shh",
      password: "p@ss",
      Authorization: "Bearer A21AAHxyz",
      nested: { refreshToken: "rtok" },
    }) as Record<string, unknown>;

    expect(result.access_token).toBe("[REDACTED]");
    expect(result.clientSecret).toBe("[REDACTED]");
    expect(result.password).toBe("[REDACTED]");
    expect(result.Authorization).toBe("[REDACTED]");
    expect((result.nested as Record<string, unknown>).refreshToken).toBe(
      "[REDACTED]",
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("A21AAHxyz");
    expect(serialized).not.toContain("shh");
    expect(serialized).not.toContain("rtok");
  });

  it("masks an email value's local part to its first two characters", () => {
    expect(redact("johnsmith@example.com")).toBe("jo*******@example.com");
    expect(redact({ payee_email: "ab@example.com" })).toEqual({
      payee_email: "ab@example.com",
    });
  });

  it("leaves non-sensitive, non-email values untouched", () => {
    expect(redact({ status: "CREATED", amount: { value: "1.00" } })).toEqual({
      status: "CREATED",
      amount: { value: "1.00" },
    });
  });

  it("stringifies bigint values instead of throwing", () => {
    expect(redact({ amountCents: 1234n })).toEqual({ amountCents: "1234" });
  });
});
