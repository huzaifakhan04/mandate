import { mandateMarkSvg } from "@/components/brand/MandateLogo";
import { LEGAL } from "@/components/ui/legal";

import type { Db } from "../db/client";
import { centsToAmount } from "../paypal/orders";
import { privateWorldApprovePath, simApprove } from "../rail/simHandler";
import { PayPalApiError } from "../paypal/fetch";
import { findOwnedSimCheckout, type SimCheckoutView } from "../services/simCheckoutApproval";
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

const simApprovePath = privateWorldApprovePath;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function htmlPage(status: number, title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Mandate · ${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#08090a;color:#f5f5f4;font:400 14px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
main{border:1px solid rgba(255,255,255,.11);border-radius:8px;padding:28px;max-width:420px;width:100%;box-sizing:border-box;background:#0e0f10}
.k{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;color:#8b8d93;margin:0}
.st{display:inline-flex;align-items:center;gap:6px;margin-top:20px;font-size:12px;color:#c8c9cc}
.st::before{content:"";width:7px;height:7px;border-radius:50%;background:#a59bd9}
.st.ok::before{background:#5cb88a}
h1{font-size:18px;font-weight:560;letter-spacing:-.01em;margin:8px 0 0}
.amount{font-size:28px;font-weight:500;letter-spacing:-.02em;margin:12px 0 0;color:#f5f5f4;font-variant-numeric:tabular-nums}
p{color:#8b8d93}
strong{color:#f5f5f4;font-weight:500}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:#c8c9cc}
button{margin-top:8px;height:34px;padding:0 14px;border:0;border-radius:6px;background:#7f86e0;color:#ffffff;font:500 13px/1 inherit;cursor:pointer}
button:hover{background:#8d93e6}
button:focus-visible,a:focus-visible{outline:2px solid rgba(127,134,224,.6);outline-offset:2px}
a{display:inline-block;margin-top:16px;color:#c8c9cc;font-size:13px;text-underline-offset:3px;text-decoration-color:rgba(255,255,255,.18)}
small{display:block;margin-top:24px;padding-top:16px;border-top:1px solid rgba(255,255,255,.065);color:#5f6268;font-size:11.5px}
</style></head>
<body><main>
<p class="k">${mandateMarkSvg(16)}Mandate · sandbox world</p>
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
    const label = checkout.status === "COMPLETED" ? "Captured" : "Approved";
    return htmlPage(
      200,
      "Checkout approved",
      `<span class="st ok">${label}</span><h1>Already approved</h1><p class="amount">${amount}</p>
<p>This simulated payment in <strong>${world}</strong> was already approved. Your agent can call <code>confirm_checkout</code>.</p>
<a href="${escapeHtml(checkout.returnPath)}">Continue</a>`,
    );
  }
  return htmlPage(
    200,
    "Approve checkout",
    `<span class="st">Simulated · no PayPal</span><h1>Approve this payment</h1><p class="amount">${amount}</p>
${
      checkout.purpose === "guarantee"
        ? `<p>Your agent's loan in your sandbox world <strong>${world}</strong> was charged off and your guarantee is invoked for <strong>${amount}</strong>. This stands in for approving in PayPal: no real or sandbox money moves. Once approved, the payment settles on its own.</p>`
        : `<p>Your agent asked to pay <strong>${amount}</strong> in your sandbox world <strong>${world}</strong>. This stands in for approving in PayPal: no real or sandbox money moves. After you approve, tell your agent to call <code>confirm_checkout</code>.</p>`
    }
<form method="post" action="${escapeHtml(simApprovePath(checkout.worldId, checkout.orderId))}"><button type="submit">Approve ${amount}</button></form>
<a href="/dashboard?world=${checkout.worldId}">Back to the dashboard</a>`,
  );
}

export type ApproveSimCheckoutOutcome =
  | { outcome: "approved"; checkout: SimCheckoutView }
  | { outcome: "already"; checkout: SimCheckoutView }
  | { outcome: "not_found" };

/**
 * Approves the owner's sim order (`PAYER_ACTION_REQUIRED → APPROVED`).
 * Approving twice, or after capture, is harmless (`already`). No
 * transaction is open here (`simApprove` is one conditional update).
 */
export async function approveOwnedSimCheckout(
  db: Db,
  principalId: string,
  worldId: string,
  orderId: string,
): Promise<ApproveSimCheckoutOutcome> {
  const checkout = await findOwnedSimCheckout(db, principalId, worldId, orderId);
  if (!checkout) {
    return { outcome: "not_found" };
  }
  if (checkout.status !== "PAYER_ACTION_REQUIRED") {
    return { outcome: "already", checkout };
  }
  try {
    await simApprove(db, orderId);
  } catch (err) {
    if (err instanceof PayPalApiError && err.status === 422) {
      return { outcome: "already", checkout };
    }
    throw err;
  }
  return { outcome: "approved", checkout: { ...checkout, status: "APPROVED" } };
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
    const gated = await gate(request, { path: here, returnTo: here }, getDb);
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
