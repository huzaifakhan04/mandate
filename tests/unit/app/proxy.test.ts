/**
 * P2 final review (I-2): the proxy marks every dashboard, claim, verify and
 * checkout response `cache-control: private, no-store`; the one-time
 * reveal cookie is still read (and cleared) on the API key page only.
 */
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { config, proxy } from "@/proxy";
import { REVEAL_COOKIE_NAME, REVEAL_HEADER_NAME } from "@/server/auth/revealCookie";

const BASE = "https://mandate.test";
const AGENT = "00000000-0000-4000-8000-000000000001";

const PRIVATE_PATHS = [
  "/dashboard",
  "/dashboard/worlds",
  `/dashboard/agents/${AGENT}/api-key`,
  `/dashboard/worlds/${AGENT}/checkouts/SIMORDER-x/approve`,
  `/claim/${"A".repeat(43)}`,
  "/verify",
  "/verify/return",
  "/checkout/notes/return",
];

function request(path: string, { cookie, method = "GET", header }: { cookie?: string; method?: string; header?: string } = {}) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = `${REVEAL_COOKIE_NAME}=${cookie}`;
  if (header) headers[REVEAL_HEADER_NAME] = header;
  return new NextRequest(`${BASE}${path}`, { method, headers });
}

/** The value the proxy forwards to the page for `name` (null when not overridden). */
function forwarded(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

describe("proxy (I-2)", () => {
  it.each(PRIVATE_PATHS)("matches %s and sets cache-control: private, no-store", (path) => {
    expect(unstable_doesMiddlewareMatch({ config, url: `${BASE}${path}` })).toBe(true);
    const response = proxy(request(path));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("does not run on public pages and the API", () => {
    for (const path of ["/", "/agents.md", "/llms.txt", "/openapi.json", "/api/v1/get_status", "/api/mcp/mcp"]) {
      expect(unstable_doesMiddlewareMatch({ config, url: `${BASE}${path}` }), path).toBe(false);
    }
  });

  it("hands the sealed reveal cookie to the API key page once and clears it", () => {
    const response = proxy(request(`/dashboard/agents/${AGENT}/api-key`, { cookie: "sealed-value" }));
    expect(forwarded(response, REVEAL_HEADER_NAME)).toBe("sealed-value");
    expect(response.headers.get("set-cookie")).toContain(`${REVEAL_COOKIE_NAME}=;`);
  });

  it("never reads the reveal cookie anywhere else, and drops a client-sent reveal header everywhere", () => {
    for (const path of ["/dashboard", `/claim/${"A".repeat(43)}`, "/checkout/notes/return"]) {
      const response = proxy(request(path, { cookie: "sealed-value", header: "forged" }));
      expect(forwarded(response, REVEAL_HEADER_NAME), path).toBeNull();
      expect(response.headers.get("set-cookie"), path).toBeNull();
    }
    // A POST to the key page doesn't consume it either.
    const post = proxy(request(`/dashboard/agents/${AGENT}/api-key`, { cookie: "sealed-value", method: "POST" }));
    expect(forwarded(post, REVEAL_HEADER_NAME)).toBeNull();
  });
});
