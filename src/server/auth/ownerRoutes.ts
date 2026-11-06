import type { Db } from "../db/client";
import {
  parseOwnerRegisterInput,
  registerOwnedAgent,
  revokeSigningKey,
  rotateApiKey,
  setAgentFrozen,
} from "../services/owner";
import { agentDashboardPath } from "./dashboardPaths";
import { principalFromRequest, signInPath } from "./guard";
import { isUuid } from "./ownership";
import { revealCookieHeader, sealReveal } from "./reveal";
import { isSameOriginPost } from "./routes";

/**
 * Owner dashboard routes (P2 Task 5), built over `getDb` so tests drive
 * them with PGlite:
 *
 * - `POST /dashboard/agents` — path B: register an agent already claimed
 *   by the signed-in principal (form: `name`, `operator`, `model`,
 *   `payout` = PayPal email or payer ID). 303 → the one-time key page.
 * - `POST /dashboard/agents/<id>/freeze` and `/unfreeze`.
 * - `POST /dashboard/agents/<id>/key/revoke` — revoke the Ed25519 signing key.
 * - `POST /dashboard/agents/<id>/api-key/rotate` — new API key, old ones
 *   revoked. 303 → the one-time key page.
 * - `POST /dashboard/claim` — "Paste claim link": 303 → `/claim/<token>`.
 *
 * Every route: same origin (403), a session (401; a browser goes to
 * /verify), and for an agent route, ownership — anyone else's agent, an
 * unknown or a malformed id → 404 (Review Focus 3). A browser form
 * (`Accept: text/html`) gets a 303; anything else JSON. The new API key
 * travels to the key page only in the sealed `mandate_reveal` cookie
 * (`reveal.ts`), never in a URL or a JSON body.
 */

const MAX_BODY_BYTES = 16 * 1024;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

function seeOther(request: Request, path: string, cookies: string[] = []): Response {
  const headers = new Headers({ location: new URL(path, request.url).toString(), "cache-control": "no-store" });
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 303, headers });
}

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
}

/** An error: JSON, or for a browser form a 303 to `back` with `?<param>=<code>` (401 → sign in; 403/404 → plain text). */
function failure(
  request: Request,
  status: number,
  code: string,
  message: string,
  back: { path: string; returnTo: string } | null,
): Response {
  if (wantsHtml(request)) {
    if (status === 401) {
      return seeOther(request, signInPath(back?.returnTo ?? "/dashboard"));
    }
    if (status === 403 || status === 404 || !back) {
      return plain(status, status === 403 ? "Forbidden" : status === 404 ? "Not found" : message);
    }
    return seeOther(request, back.path);
  }
  return json(status, { error: code, message });
}

function agentBack(agentId: string, query: Record<string, string>) {
  return { path: agentDashboardPath(agentId, query), returnTo: `/dashboard?agent=${agentId}` };
}

/** Same origin, then a session, then the body size. The principal id, or the refusal. */
function gate(
  request: Request,
  back: { path: string; returnTo: string } | null,
): { principalId: string } | Response {
  if (!isSameOriginPost(request)) {
    return failure(request, 403, "forbidden", "Forbidden.", back);
  }
  const session = principalFromRequest(request);
  if (!session) {
    return failure(request, 401, "unauthorized", "Sign in with PayPal to continue.", back);
  }
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return failure(request, 413, "too_large", "The request body is too large.", back);
  }
  return { principalId: session.principalId };
}

async function readFields(request: Request): Promise<Record<string, unknown> | null> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = (await request.json()) as unknown;
      return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    }
    const form = await request.formData();
    const out: Record<string, unknown> = {};
    for (const [name, value] of form.entries()) {
      if (typeof value === "string") {
        out[name] = value;
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** The one-time key page for `agentId`. */
export function apiKeyPagePath(agentId: string): string {
  return `/dashboard/agents/${agentId}/api-key`;
}

/** A claim token pasted as the full link (`…/claim/<token>`) or on its own; `null` if it isn't one. */
export function claimTokenFromPaste(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  const match = /(?:^|\/claim\/)([A-Za-z0-9_-]{43})\/?(?:[?#].*)?$/.exec(trimmed);
  return match ? match[1]! : null;
}

export function createOwnerHandlers({ getDb }: { getDb: () => Promise<Db> }) {
  async function register(request: Request): Promise<Response> {
    const back = { path: "/dashboard/agents/new", returnTo: "/dashboard/agents/new" };
    const gated = gate(request, back);
    if (gated instanceof Response) {
      return gated;
    }
    const fields = await readFields(request);
    const parsed = fields ? parseOwnerRegisterInput(fields) : ({ ok: false, errors: ["name"] } as const);
    if (!parsed.ok) {
      const query = new URLSearchParams({ error: "invalid", fields: parsed.errors.join(",") });
      for (const name of ["name", "operator", "model"] as const) {
        const value = fields?.[name];
        if (typeof value === "string" && value.length <= 80) {
          query.set(name, value);
        }
      }
      return wantsHtml(request)
        ? seeOther(request, `/dashboard/agents/new?${query.toString()}`)
        : json(400, { error: "invalid_agent", message: "Some fields are missing or invalid.", fields: parsed.errors });
    }
    try {
      const result = await registerOwnedAgent(await getDb(), gated.principalId, parsed.input);
      const cookie = revealCookieHeader(
        sealReveal({ principalId: gated.principalId, agentId: result.agentId, apiKey: result.apiKey, kind: "registered" }),
      );
      return wantsHtml(request)
        ? seeOther(request, apiKeyPagePath(result.agentId), [cookie])
        : json(201, { agent_id: result.agentId, api_key: result.apiKey, status: "ACTIVE", tier: 0 });
    } catch (err) {
      console.error(`[owner] register failed: ${err instanceof Error ? err.name : "unknown error"}`);
      return failure(request, 500, "error", "Something went wrong registering this agent.", {
        path: "/dashboard/agents/new?error=error",
        returnTo: "/dashboard/agents/new",
      });
    }
  }

  /** The common shape of an agent action: id check, gate, run, map the outcome. */
  type ActionResult = { status: number; code: string; message: string; notice: Record<string, string> };

  async function agentAction(
    request: Request,
    agentId: string,
    run: (principalId: string) => Promise<ActionResult>,
  ): Promise<Response> {
    if (!isUuid(agentId)) {
      return failure(request, 404, "not_found", "Agent not found.", null);
    }
    const gated = gate(request, agentBack(agentId, {}));
    if (gated instanceof Response) {
      return gated;
    }
    try {
      const result = await run(gated.principalId);
      if (result.status === 404) {
        return failure(request, 404, "not_found", "Agent not found.", null);
      }
      if (result.status >= 400) {
        return failure(request, result.status, result.code, result.message, agentBack(agentId, result.notice));
      }
      return wantsHtml(request)
        ? seeOther(request, agentDashboardPath(agentId, result.notice))
        : json(result.status, { ok: true, result: result.code });
    } catch (err) {
      console.error(`[owner] action failed: ${err instanceof Error ? err.name : "unknown error"}`);
      return failure(request, 500, "error", "Something went wrong.", agentBack(agentId, { error: "error" }));
    }
  }

  function freeze(frozen: boolean) {
    return (request: Request, agentId: string) =>
      agentAction(request, agentId, async (principalId): Promise<ActionResult> => {
        const outcome = await setAgentFrozen(await getDb(), { principalId, agentId, frozen });
        switch (outcome) {
          case "not_found":
            return { status: 404, code: "not_found", message: "Agent not found.", notice: {} };
          case "conflict":
            return {
              status: 409,
              code: frozen ? "not_freezable" : "not_frozen",
              message: frozen ? "Only an active agent can be frozen." : "This agent is not frozen.",
              notice: { error: frozen ? "not_freezable" : "not_frozen" },
            };
          default:
            return { status: 200, code: outcome, message: "", notice: { agent_status: outcome } };
        }
      });
  }

  async function revokeKey(request: Request, agentId: string): Promise<Response> {
    return agentAction(request, agentId, async (principalId): Promise<ActionResult> => {
      const outcome = await revokeSigningKey(await getDb(), { principalId, agentId });
      switch (outcome) {
        case "not_found":
          return { status: 404, code: "not_found", message: "Agent not found.", notice: {} };
        case "no_key":
          return { status: 409, code: "no_key", message: "This agent has no active signing key.", notice: { error: "no_key" } };
        case "revoked":
          return { status: 200, code: "revoked", message: "", notice: { key: "revoked" } };
      }
    });
  }

  async function rotate(request: Request, agentId: string): Promise<Response> {
    if (!isUuid(agentId)) {
      return failure(request, 404, "not_found", "Agent not found.", null);
    }
    const gated = gate(request, agentBack(agentId, {}));
    if (gated instanceof Response) {
      return gated;
    }
    try {
      const result = await rotateApiKey(await getDb(), { principalId: gated.principalId, agentId });
      if (result.outcome === "not_found") {
        return failure(request, 404, "not_found", "Agent not found.", null);
      }
      if (result.outcome === "conflict") {
        return failure(request, 409, "agent_revoked", "A revoked agent can't be given a new key.", agentBack(agentId, { error: "agent_revoked" }));
      }
      const cookie = revealCookieHeader(
        sealReveal({ principalId: gated.principalId, agentId, apiKey: result.apiKey, kind: "rotated" }),
      );
      return wantsHtml(request)
        ? seeOther(request, apiKeyPagePath(agentId), [cookie])
        : json(200, { agent_id: agentId, api_key: result.apiKey });
    } catch (err) {
      console.error(`[owner] rotate failed: ${err instanceof Error ? err.name : "unknown error"}`);
      return failure(request, 500, "error", "Something went wrong.", agentBack(agentId, { error: "error" }));
    }
  }

  async function pasteClaim(request: Request): Promise<Response> {
    const back = { path: "/dashboard?claim_error=invalid", returnTo: "/dashboard" };
    const gated = gate(request, back);
    if (gated instanceof Response) {
      return gated;
    }
    const fields = await readFields(request);
    const token = claimTokenFromPaste(fields?.claim_link);
    if (!token) {
      return failure(request, 400, "invalid_claim_link", "That doesn't look like a Mandate claim link.", back);
    }
    return wantsHtml(request) ? seeOther(request, `/claim/${token}`) : json(200, { location: `/claim/${token}` });
  }

  return {
    register,
    freeze: freeze(true),
    unfreeze: freeze(false),
    revokeKey,
    rotate,
    pasteClaim,
  };
}
