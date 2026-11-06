import type { Db } from "../db/client";
import { centsToAmount } from "../paypal/orders";
import { privateWorldApprovePath } from "../rail/simHandler";
import { approveOwnedSimCheckout, findOwnedSimCheckout, type SimCheckoutView } from "../services/simCheckoutApproval";
import { principalFromRequest, signInPath } from "./guard";
import { isUuid } from "./ownership";
import { failure, gate, json, seeOther, wantsHtml } from "./ownerRoutes";

/**
 * P2 final review (I-1): `/dashboard/worlds/<id>/checkouts/<orderId>/approve`
 * — the sim stand-in for PayPal's approval page in a private world (the
 * `payer-action` link of every sim order there, see `simHandler.ts`).
 *
 * - `GET` — signed out → Verify with PayPal (returning here); the world's
 *   owner → a page with the amount and one **Approve** button; anyone
 *   else, the main world, an archived world or an unknown order → 404.
 * - `POST` — same origin (403) → session (401) → ownership (404) →
 *   `simApprove`, then 303 to the order's checkout return page
 *   (`/checkout/<kind>/return?token=<orderId>`), which settles it. Approving
 *   an already-approved/captured order just redirects.
 */

const LEGAL = "Sandbox model · simulated money · notes are not deposits and not FDIC-insured";

const simApprovePath = privateWorldApprovePath;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function htmlPage(status: number, title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Mandate · ${escapeHtml(title)}</title>
<style>
body{margin:0;background:#f6f7f9;color:#15181d;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
main{background:#fff;border:1px solid #e3e6eb;border-radius:14px;padding:32px;max-width:420px;width:100%;box-sizing:border-box;box-shadow:0 1px 2px rgba(21,24,29,.04),0 4px 16px rgba(21,24,29,.06)}
.k{font-size:13px;font-weight:600;color:#5b6472;margin:0}
.pill{display:inline-block;margin-top:16px;font-size:11px;font-weight:700;letter-spacing:.04em;padding:3px 9px;border-radius:999px;color:#8f5500;background:#fff4e0}
.pill.ok{color:#0a7a44;background:#e8f5ee}
h1{font-size:22px;letter-spacing:-.02em;margin:8px 0 0}
.amount{font-size:32px;font-weight:700;letter-spacing:-.02em;margin:16px 0 0;color:#0a7a44}
p{color:#5b6472}
button{margin-top:16px;width:100%;border:0;border-radius:10px;background:#1d4ed8;color:#fff;font:600 15px/1 inherit;padding:14px;cursor:pointer}
a{display:inline-block;margin-top:12px;color:#1d4ed8;font-weight:600;text-decoration:none}
small{display:block;margin-top:24px;color:#6b7380;font-size:11px}
</style></head>
<body><main>
<p class="k">Mandate · sandbox world</p>
${body}
<small>${LEGAL}</small>
</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "referrer-policy": "same-origin",
    },
  });
}

function notFoundPage(): Response {
  return htmlPage(
    404,
    "Checkout not found",
    `<h1>Checkout not found</h1><p>This simulated checkout doesn't exist, or it isn't in one of your active sandbox worlds.</p><a href="/dashboard/worlds">Your sandbox worlds</a>`,
  );
}

function checkoutPage(checkout: SimCheckoutView): Response {
  const amount = `$${centsToAmount(checkout.amountCents)}`;
  const world = escapeHtml(checkout.worldName);
  if (checkout.status !== "PAYER_ACTION_REQUIRED") {
    const label = checkout.status === "COMPLETED" ? "CAPTURED" : "APPROVED";
    return htmlPage(
      200,
      "Checkout approved",
      `<span class="pill ok">${label}</span><h1>Already approved</h1><p class="amount">${amount}</p>
<p>This simulated payment in <strong>${world}</strong> was already approved. Your agent can call <code>confirm_checkout</code>.</p>
<a href="${escapeHtml(checkout.returnPath)}">Continue</a>`,
    );
  }
  return htmlPage(
    200,
    "Approve checkout",
    `<span class="pill">SIMULATED · NO PAYPAL</span><h1>Approve this payment</h1><p class="amount">${amount}</p>
<p>Your agent asked to pay <strong>${amount}</strong> in your sandbox world <strong>${world}</strong>. This stands in for approving in PayPal: no real or sandbox money moves. After you approve, tell your agent to call <code>confirm_checkout</code>.</p>
<form method="post" action="${escapeHtml(simApprovePath(checkout.worldId, checkout.orderId))}"><button type="submit">Approve ${amount}</button></form>
<a href="/dashboard?world=${checkout.worldId}">Back to the dashboard</a>`,
  );
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown error";
}

export function createSimApproveHandlers({ getDb }: { getDb: () => Promise<Db> }) {
  async function show(request: Request, worldId: string, orderId: string): Promise<Response> {
    if (!isUuid(worldId)) {
      return notFoundPage();
    }
    const session = principalFromRequest(request);
    if (!session) {
      return seeOther(request, signInPath(simApprovePath(worldId, orderId)));
    }
    const checkout = await findOwnedSimCheckout(await getDb(), session.principalId, worldId, orderId);
    return checkout ? checkoutPage(checkout) : notFoundPage();
  }

  async function approve(request: Request, worldId: string, orderId: string): Promise<Response> {
    if (!isUuid(worldId)) {
      return failure(request, 404, "not_found", "Checkout not found.", null);
    }
    const here = simApprovePath(worldId, orderId);
    const gated = gate(request, { path: here, returnTo: here });
    if (gated instanceof Response) {
      return gated;
    }
    try {
      const result = await approveOwnedSimCheckout(await getDb(), gated.principalId, worldId, orderId);
      if (result.outcome === "not_found") {
        return failure(request, 404, "not_found", "Checkout not found.", null);
      }
      return wantsHtml(request)
        ? seeOther(request, result.checkout.returnPath)
        : json(200, {
            ok: true,
            checkout_id: orderId,
            status: result.outcome === "approved" ? "APPROVED" : result.checkout.status,
            return_path: result.checkout.returnPath,
          });
    } catch (err) {
      console.error(`[sim-approve] failed: ${errorName(err)}`);
      return failure(request, 500, "error", "Something went wrong approving this checkout.", null);
    }
  }

  return { show, approve };
}
