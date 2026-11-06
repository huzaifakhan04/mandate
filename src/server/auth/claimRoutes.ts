import type { Db } from "../db/client";
import { claimAgent } from "../services/claims";
import { principalFromRequest, signInPath } from "./guard";
import { isSameOriginPost } from "./routes";

/**
 * `POST /claim/<token>/accept` — the claim page's "Claim agent" button
 * (P2 Task 2). Same-origin form POST only (403 otherwise). Then:
 *
 * - no session → 303 to Verify with PayPal, returning to the claim page;
 * - claimed (or already yours), expired, unknown → 303 back to the claim
 *   page, which renders the matching state;
 * - already claimed by someone else → 409 page.
 *
 * The token is never logged, and a malformed one never reaches a
 * redirect (404).
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

function plain(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
}

/** A self-contained 409 page in the light theme (globals.css tokens, inlined). */
function conflictPage(): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">
<title>Mandate · Agent already claimed</title>
<style>
body{margin:0;background:#f6f7f9;color:#15181d;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
main{background:#fff;border:1px solid #e3e6eb;border-radius:16px;padding:32px;max-width:420px;width:100%;box-sizing:border-box;box-shadow:0 1px 2px rgba(21,24,29,.04),0 4px 16px rgba(21,24,29,.06)}
.k{font-size:13px;font-weight:600;color:#5b6472;margin:0}
.pill{display:inline-block;margin-top:16px;font-size:11px;font-weight:700;letter-spacing:.04em;padding:3px 9px;border-radius:999px;color:#d93025;background:#fcedec}
h1{font-size:22px;letter-spacing:-.02em;margin:8px 0 0}
p{color:#5b6472}
a{display:inline-block;margin-top:8px;color:#1d4ed8;font-weight:600;text-decoration:none}
small{display:block;margin-top:24px;color:#8a93a1;font-size:11px}
</style></head>
<body><main>
<p class="k">Mandate</p>
<span class="pill">409 · CONFLICT</span>
<h1>This agent has already been claimed</h1>
<p>Another verified PayPal account owns this agent, so it can't be claimed again. If you think this is your agent, ask it for its status and contact the person who claimed it.</p>
<a href="/dashboard">Go to your dashboard</a>
<small>Sandbox model · simulated money · notes are not deposits and not FDIC-insured</small>
</main></body></html>`;
  return new Response(html, {
    status: 409,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

export function createClaimHandler({ getDb }: { getDb: () => Promise<Db> }) {
  return async function POST(request: Request, token: string): Promise<Response> {
    if (!TOKEN_RE.test(token)) {
      return plain(404, "Not found");
    }
    if (!isSameOriginPost(request)) {
      return plain(403, "Forbidden");
    }
    const claimPath = `/claim/${token}`;
    const claimPage = new URL(claimPath, request.url).toString();
    const session = principalFromRequest(request);
    if (!session) {
      return seeOther(new URL(signInPath(claimPath), request.url).toString());
    }

    let outcome: Awaited<ReturnType<typeof claimAgent>>["outcome"];
    try {
      outcome = (await claimAgent(await getDb(), session.principalId, token)).outcome;
    } catch (err) {
      // Never log the token or the URL.
      console.error(`[claim] failed: ${err instanceof Error ? err.name : "unknown error"}`);
      return plain(500, "Something went wrong claiming this agent. Please try again.");
    }
    switch (outcome) {
      case "claimed_by_other":
        return conflictPage();
      case "principal_unverified":
        return seeOther(new URL(signInPath(claimPath), request.url).toString());
      case "claimed":
      case "already_yours":
      case "expired":
      case "invalid":
        return seeOther(claimPage);
    }
  };
}
