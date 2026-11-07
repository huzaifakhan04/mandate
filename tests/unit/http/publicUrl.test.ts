/**
 * Redirect targets must use the public origin. Self-hosted `next start`
 * (Render) builds `request.url` from its bind address — observed live as
 * `https://localhost:10000/...` — so there the origin comes from
 * PUBLIC_BASE_URL. Vercel, `next dev` and tests keep `request.url`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { absoluteUrl } from "@/server/http/publicUrl";

const req = new Request("https://localhost:10000/verify/return?token=X");

describe("absoluteUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("self-hosted production: resolves against PUBLIC_BASE_URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("PUBLIC_BASE_URL", "https://mandate-bank.onrender.com");
    expect(absoluteUrl("/", req)).toBe("https://mandate-bank.onrender.com/");
    expect(absoluteUrl("/verify/error?reason=x", req)).toBe("https://mandate-bank.onrender.com/verify/error?reason=x");
  });

  it("on Vercel: keeps the request origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("PUBLIC_BASE_URL", "https://mandate-bank.onrender.com");
    expect(absoluteUrl("/", req)).toBe("https://localhost:10000/");
  });

  it("outside production, or with no/invalid PUBLIC_BASE_URL: keeps the request origin", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("PUBLIC_BASE_URL", "https://mandate-bank.onrender.com");
    expect(absoluteUrl("/", req)).toBe("https://localhost:10000/");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_BASE_URL", "");
    expect(absoluteUrl("/", req)).toBe("https://localhost:10000/");
    vi.stubEnv("PUBLIC_BASE_URL", "not a url");
    expect(absoluteUrl("/", req)).toBe("https://localhost:10000/");
  });

  it("never lets a path escape to another origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("PUBLIC_BASE_URL", "https://mandate-bank.onrender.com");
    expect(absoluteUrl("/dashboard?x=1", req)).toBe("https://mandate-bank.onrender.com/dashboard?x=1");
  });
});
