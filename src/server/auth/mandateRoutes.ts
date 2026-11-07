import type { Db } from "../db/client";
import { dollarsToCentsField, percentToBpsField, type MandateSignInput } from "../domain/mandate";
import { clientIp, revokeMandate, signMandate, type MandateRow } from "../services/mandates";
import { bufferRequestCapped } from "../http/body";
import { agentDashboardPath } from "./dashboardPaths";
import { principalFromRequest, signInPath } from "./guard";
import { isUuid } from "./ownership";
import { dashboardRateLimit } from "./ownerRoutes";
import { isSameOriginPost } from "./routes";

/**
 * Owner mandate routes (P2 Task 4), built over `getDb` so tests drive them
 * with PGlite. Task 5's dashboard posts its forms here.
 *
 * - `POST /dashboard/agents/<id>/mandate` — sign a new version. Fields:
 *   `max_per_loan_cents`, `max_total_owed_cents`, `max_fee_bps`,
 *   `max_term_days`, `eligible_collateral` (array, repeated form field or
 *   comma-separated), optional `expires_at`, `typed_name` and `agree`.
 *   JSON, urlencoded or multipart. A form may instead send the limits as
 *   the dashboard asks for them: `max_per_loan_usd`, `max_total_owed_usd`
 *   (dollars, up to 2 decimals) and `max_fee_pct` (percent, up to 2 decimals).
 * - `POST /dashboard/agents/<id>/mandate/revoke` — revoke the current one.
 *
 * Session (401) + ownership (anyone else's agent or a malformed id → 404,
 * Review Focus 3) + same origin (403). A browser form (`Accept:
 * text/html`) gets a 303 back to the agent page; anything else JSON.
 */

const MAX_BODY_BYTES = 16 * 1024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

function seeOther(request: Request, path: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: new URL(path, request.url).toString(), "cache-control": "no-store" },
  });
}

function agentPage(agentId: string, query: Record<string, string> = {}): string {
  return agentDashboardPath(agentId, query);
}

function failure(
  request: Request,
  agentId: string,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  if (wantsHtml(request)) {
    if (status === 401) {
      return seeOther(request, signInPath(`/dashboard?agent=${agentId}`));
    }
    if (status === 403 || status === 404) {
      return new Response(status === 403 ? "Forbidden" : "Not found", {
        status,
        headers: { "content-type": "text/plain", "cache-control": "no-store" },
      });
    }
    const fields: Record<string, string> = Array.isArray(extra.fields) ? { fields: (extra.fields as string[]).join(",") } : {};
    return seeOther(request, agentPage(agentId, { mandate_error: code, ...fields }));
  }
  return json(status, { error: code, message, ...extra });
}

export function mandateJson(row: MandateRow) {
  return {
    id: row.id,
    agent_id: row.agentId,
    version: row.version,
    status: row.status,
    max_per_loan_cents: Number(row.maxPerLoanCents),
    max_total_owed_cents: Number(row.maxTotalOwedCents),
    max_fee_bps: row.maxFeeBps,
    max_term_days: row.maxTermDays,
    eligible_collateral: [...row.eligibleCollateral],
    expires_at: row.expiresAt ? row.expiresAt.toISOString() : null,
    signer_name: row.signerName,
    signed_at: row.signedAt ? row.signedAt.toISOString() : null,
    terms_hash: row.termsHash,
    revoked_at: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

/** The sign fields from a JSON, urlencoded or multipart body; `null` if unreadable. */
async function readSignInput(request: Request): Promise<MandateSignInput | null> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = (await request.json()) as unknown;
      return body && typeof body === "object" && !Array.isArray(body) ? (body as MandateSignInput) : null;
    }
    const form = await request.formData();
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : undefined;
    };
    const collateral = form.getAll("eligible_collateral").filter((v): v is string => typeof v === "string");
    // The dashboard form asks in dollars and percent; cents/bps win when both are sent.
    return {
      max_per_loan_cents: field("max_per_loan_cents") ?? dollarsToCentsField(field("max_per_loan_usd")),
      max_total_owed_cents: field("max_total_owed_cents") ?? dollarsToCentsField(field("max_total_owed_usd")),
      max_fee_bps: field("max_fee_bps") ?? percentToBpsField(field("max_fee_pct")),
      max_term_days: field("max_term_days"),
      eligible_collateral: collateral.length > 1 ? collateral : collateral[0],
      expires_at: field("expires_at"),
      typed_name: field("typed_name"),
      agree: field("agree"),
    };
  } catch {
    return null;
  }
}

export function createMandateHandlers({ getDb }: { getDb: () => Promise<Db> }) {
  /**
   * The common gate: id, same origin, session, body size (P8: enforced
   * while streaming, so a chunked body without Content-Length is capped
   * too), then the per-principal dashboard rate limit. Returns the
   * principal id and a buffered copy of the request, or a response.
   */
  async function gate(request: Request, agentId: string): Promise<{ principalId: string; request: Request } | Response> {
    if (!isUuid(agentId)) {
      return failure(request, agentId, 404, "not_found", "Agent not found.");
    }
    if (!isSameOriginPost(request)) {
      return failure(request, agentId, 403, "forbidden", "Forbidden.");
    }
    const session = principalFromRequest(request);
    if (!session) {
      return failure(request, agentId, 401, "unauthorized", "Sign in with PayPal to continue.");
    }
    const buffered = await bufferRequestCapped(request, MAX_BODY_BYTES);
    if (!buffered) {
      return failure(request, agentId, 413, "too_large", "The request body is too large.");
    }
    const limited = await dashboardRateLimit(request, getDb, session.principalId, null);
    if (limited) {
      return limited;
    }
    return { principalId: session.principalId, request: buffered };
  }

  async function sign(request: Request, agentId: string): Promise<Response> {
    const gated = await gate(request, agentId);
    if (gated instanceof Response) {
      return gated;
    }
    const input = await readSignInput(gated.request);
    if (!input) {
      return failure(request, agentId, 400, "invalid_body", "Send the mandate fields as JSON or a form.");
    }
    try {
      const result = await signMandate(await getDb(), {
        principalId: gated.principalId,
        agentId,
        input,
        ip: clientIp(request),
      });
      switch (result.outcome) {
        case "not_found":
          return failure(request, agentId, 404, "not_found", "Agent not found.");
        case "invalid":
          return failure(request, agentId, 400, "invalid_mandate", "Some mandate fields are missing or out of range.", {
            fields: result.errors,
          });
        case "signed":
          return wantsHtml(request)
            ? seeOther(request, agentPage(agentId, { mandate: "signed" }))
            : json(201, {
                mandate: mandateJson(result.mandate),
                superseded: result.superseded ? { id: result.superseded.id, version: result.superseded.version } : null,
              });
      }
    } catch (err) {
      console.error(`[mandates] sign failed: ${err instanceof Error ? err.name : "unknown error"}`);
      return failure(request, agentId, 500, "error", "Something went wrong signing this mandate.");
    }
  }

  async function revoke(request: Request, agentId: string): Promise<Response> {
    const gated = await gate(request, agentId);
    if (gated instanceof Response) {
      return gated;
    }
    try {
      const result = await revokeMandate(await getDb(), { principalId: gated.principalId, agentId });
      switch (result.outcome) {
        case "not_found":
          return failure(request, agentId, 404, "not_found", "Agent not found.");
        case "no_mandate":
          return failure(request, agentId, 409, "no_mandate", "This agent has no mandate in force.");
        case "revoked":
          return wantsHtml(request)
            ? seeOther(request, agentPage(agentId, { mandate: "revoked" }))
            : json(200, { mandate: mandateJson(result.mandate) });
      }
    } catch (err) {
      console.error(`[mandates] revoke failed: ${err instanceof Error ? err.name : "unknown error"}`);
      return failure(request, agentId, 500, "error", "Something went wrong revoking this mandate.");
    }
  }

  return { sign, revoke };
}
