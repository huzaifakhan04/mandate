import { mandateMarkSvg } from "@/components/brand/MandateLogo";
import { LEGAL } from "@/components/ui/legal";

import type { Db } from "../db/client";
import { absoluteUrl } from "../http/publicUrl";
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

/** A self-contained 409 page in the dark theme (globals.css tokens, inlined). */
function conflictPage(): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><meta name="color-scheme" content="dark">
<title>Mandate · Agent already claimed</title>
<style>
html,body{background:#08090a}
body{margin:0;color:#f5f5f4;font:400 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased;display:flex;justify-content:center;padding:72px 16px 32px;box-sizing:border-box;min-height:100vh}
main{width:100%;max-width:400px;display:flex;flex-direction:column;gap:20px}
.k{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:560;color:#f5f5f4;text-decoration:none;align-self:flex-start}
.st{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#c8c9cc;margin:0 0 12px}
.st::before{content:"";width:7px;height:7px;border-radius:50%;background:#e5675e}
h1{font-size:20px;font-weight:560;letter-spacing:-.015em;line-height:1.25;margin:0}
p{margin:8px 0 0;color:#8b8d93;font-size:13.5px;line-height:1.55}
.act{border-top:1px solid rgba(255,255,255,.11);padding-top:20px}
.btn{display:inline-flex;align-items:center;height:34px;padding:0 14px;border-radius:6px;background:#7f86e0;color:#f5f5f4;font-weight:500;text-decoration:none}
.btn:hover{background:#8d93e6}
a:focus-visible{outline:2px solid rgba(127,134,224,.6);outline-offset:2px}
small{display:block;margin-top:24px;color:#5f6268;font-size:11.5px}
</style></head>
<body><main>
<a class="k" href="/" aria-label="Mandate home">${mandateMarkSvg(16)}<span aria-hidden="true">Mandate</span></a>
<div><p class="st">409 · Conflict</p>
<h1>This agent has already been claimed</h1>
<p>Another verified PayPal account owns this agent, so it can't be claimed again. If you think this is your agent, ask it for its status and contact the person who claimed it.</p></div>
<div class="act"><a class="btn" href="/dashboard">Go to your dashboard</a></div>
<small>${LEGAL}</small>
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
    const claimPage = absoluteUrl(claimPath, request);
    const session = principalFromRequest(request);
    if (!session) {
      return seeOther(absoluteUrl(signInPath(claimPath), request));
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
        return seeOther(absoluteUrl(signInPath(claimPath), request));
      case "claimed":
      case "already_yours":
      case "expired":
      case "invalid":
        return seeOther(claimPage);
    }
  };
}
