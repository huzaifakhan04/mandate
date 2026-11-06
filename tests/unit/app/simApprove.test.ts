/**
 * P2 final review (I-1): in a private world the sim order's `payer-action`
 * link is the owner's approval page, so a human (path B) agent there can
 * complete every `human_approval`: buy notes, and repay a loan.
 *
 * GET shows the page (signed out → Verify with PayPal); POST is same
 * origin → session → ownership (another principal, the main world, an
 * unknown order or one from another world → 404), then `simApprove` and a
 * 303 to the order's checkout return page.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME, createSession } from "@/server/auth/session";
import { createSimApproveHandlers } from "@/server/auth/simApproveRoutes";
import type { Envelope, NextAction } from "@/server/contracts/envelope";
import type { Db } from "@/server/db/client";
import { loans, principals } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { registerOwnedAgent } from "@/server/services/owner";
import { createPrivateWorld } from "@/server/services/privateWorlds";

import { claimAndMandate } from "../../helpers/kya";
import { call, createSimWorld, createTestAgent, type Data } from "../../helpers/world";

const ORIGIN = "https://mandate.test";
const EVIL = "https://evil.example.com";

describe("private-world sim checkout approval (I-1)", () => {
  let db: Db;
  let handlers: ReturnType<typeof createSimApproveHandlers>;
  let owner: string;
  let other: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    vi.stubEnv("PUBLIC_BASE_URL", ORIGIN);
    db = await createTestDb();
    handlers = createSimApproveHandlers({ getDb: async () => db });
    owner = await newPrincipal("OWNER");
    other = await newPrincipal("OTHER");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function newPrincipal(name: string): Promise<string> {
    const [row] = await db
      .insert(principals)
      .values({ paypalPayerId: name, email: `${name}@example.com`, name, entityType: "individual", verifiedAt: new Date() })
      .returning();
    return row!.id;
  }

  async function makeWorld(principalId = owner): Promise<string> {
    const created = await createPrivateWorld(db, principalId, { name: "Rehearsal" });
    if (created.outcome !== "created") throw new Error(created.outcome);
    return created.worldId;
  }

  async function pathBAgent(worldId: string) {
    const registered = await registerOwnedAgent(
      db,
      owner,
      { name: "Human agent", operator: "me", model: "claude", payoutEmail: "human-agent@example.com" },
      new Date(),
      { worldId },
    );
    if (registered.outcome !== "registered") throw new Error(registered.outcome);
    return registered;
  }

  function cookie(principalId: string | null): Record<string, string> {
    return principalId ? { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSession(principalId))}` } : {};
  }

  function get(url: string, principalId: string | null): Request {
    return new Request(url, { headers: { accept: "text/html", ...cookie(principalId) } });
  }

  function post(url: string, principalId: string | null, { origin = ORIGIN, html = true } = {}): Request {
    return new Request(url, {
      method: "POST",
      headers: { origin, accept: html ? "text/html" : "application/json", ...cookie(principalId) },
    });
  }

  /** The `human_approval` url and its checkout id. */
  function approval(envelope: Envelope<unknown>): { url: string; checkoutId: string } {
    const action = envelope.next_actions.find((a: NextAction) => a.tool === "human_approval")!;
    const args = action.args as { url: string; then: { args: { checkout_id: string } } };
    return { url: args.url, checkoutId: args.then.args.checkout_id };
  }

  function routeParams(url: string): { worldId: string; orderId: string } {
    const match = /\/dashboard\/worlds\/([^/]+)\/checkouts\/([^/]+)\/approve$/.exec(new URL(url).pathname);
    expect(match, url).toBeTruthy();
    return { worldId: match![1]!, orderId: decodeURIComponent(match![2]!) };
  }

  it("a path B agent buys notes, lends, borrows and repays — the owner approves each checkout on the page", async () => {
    const worldId = await makeWorld();
    const agent = await pathBAgent(worldId);
    await claimAndMandate(db, agent.agentId, { principalId: owner });

    // buy_notes → the human_approval url is the owner's approval page.
    const buy = await call(db, "buy_notes", agent.apiKey, { amount_cents: 5000 });
    expect(buy.envelope.status).toBe("AWAITING_APPROVAL");
    const buyApproval = approval(buy.envelope);
    expect(buyApproval.url.startsWith(`${ORIGIN}/dashboard/worlds/${worldId}/checkouts/`)).toBe(true);
    const buyRoute = routeParams(buyApproval.url);
    expect(buyRoute).toEqual({ worldId, orderId: buyApproval.checkoutId });

    // GET: the page with the button (signed out → Verify with PayPal).
    const signedOut = await handlers.show(get(buyApproval.url, null), buyRoute.worldId, buyRoute.orderId);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toContain("/verify?return_to=");
    const page = await handlers.show(get(buyApproval.url, owner), buyRoute.worldId, buyRoute.orderId);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    const html = await page.text();
    expect(html).toContain("$50.00");
    expect(html).toContain(`method="post"`);
    expect(html).toContain("not deposits and not FDIC-insured");

    // Not yet approved → confirm says so.
    expect((await call(db, "confirm_checkout", agent.apiKey, { checkout_id: buyApproval.checkoutId })).envelope.status).toBe(
      "AWAITING_APPROVAL",
    );

    // POST approve → 303 to the notes return page with the order token.
    const approved = await handlers.approve(post(buyApproval.url, owner), buyRoute.worldId, buyRoute.orderId);
    expect(approved.status).toBe(303);
    expect(approved.headers.get("location")).toBe(
      `${ORIGIN}/checkout/notes/return?token=${encodeURIComponent(buyApproval.checkoutId)}`,
    );
    const confirmed = await call(db, "confirm_checkout", agent.apiKey, { checkout_id: buyApproval.checkoutId });
    expect(confirmed.envelope.status).toBe("COMPLETED");
    const status = await call(db, "get_status", agent.apiKey, {});
    expect(JSON.stringify(status.envelope.data)).toContain("5000");

    // Approving again just redirects (already approved / captured).
    expect((await handlers.approve(post(buyApproval.url, owner), buyRoute.worldId, buyRoute.orderId)).status).toBe(303);

    // Borrow: apply → accept → ACTIVE.
    const offer = await call(db, "apply_for_loan", agent.apiKey, { amount_cents: 5000, term_days: 7, purpose: "Working capital" });
    expect(offer.envelope.status).toBe("OFFERED");
    const offerData = offer.envelope.data as Data;
    const accepted = await call(db, "accept_offer", agent.apiKey, {
      offer_id: offerData.offer_id,
      disclosure_hash: offerData.disclosure_hash,
    });
    expect(accepted.envelope.status).toBe("ACTIVE");
    const loanId = (accepted.envelope.data as Data).loan_id as string;

    // Repay: the owner approves on the page; the agent confirms → REPAID.
    const repay = await call(db, "repay_loan", agent.apiKey, { loan_id: loanId });
    expect(repay.envelope.status).toBe("AWAITING_APPROVAL");
    const repayApproval = approval(repay.envelope);
    const repayRoute = routeParams(repayApproval.url);
    expect(repayRoute.worldId).toBe(worldId);
    const repayApproved = await handlers.approve(post(repayApproval.url, owner), repayRoute.worldId, repayRoute.orderId);
    expect(repayApproved.status).toBe(303);
    expect(repayApproved.headers.get("location")).toContain("/checkout/repay/return?token=");
    const repaid = await call(db, "confirm_checkout", agent.apiKey, { checkout_id: repayApproval.checkoutId });
    expect(repaid.envelope.status).toBe("COMPLETED");
    const [loan] = await db.select().from(loans).where(eq(loans.id, loanId));
    expect(loan!.status).toBe("repaid");
  }, 60_000);

  it("ownership: another principal, the main world, another world's order, an unknown order → 404; CSRF 403; signed out 401", async () => {
    const worldId = await makeWorld();
    const agent = await pathBAgent(worldId);
    const buy = await call(db, "buy_notes", agent.apiKey, { amount_cents: 1000 });
    const { url, checkoutId } = approval(buy.envelope);

    // A main-world sim order keeps the inert sim link and can't be approved here.
    const mainWorld = await createSimWorld(db);
    const mainAgent = await createTestAgent(db, mainWorld, "main@example.com");
    const mainBuy = await call(db, "buy_notes", mainAgent.key, { amount_cents: 1000 });
    const mainApproval = approval(mainBuy.envelope);
    expect(mainApproval.url).toContain("sim.paypal.local");

    const otherWorld = await makeWorld(other);
    const json = { html: false };
    for (const [who, world, order] of [
      [other, worldId, checkoutId], // someone else's world
      [owner, mainWorld, mainApproval.checkoutId], // the main world
      [owner, worldId, mainApproval.checkoutId], // an order from another world
      [other, otherWorld, checkoutId], // their own world, my order
      [owner, worldId, "SIMORDER-00000000-0000-0000-0000-000000000000"], // unknown
      [owner, worldId, "not-an-order"],
      [owner, "not-a-uuid", checkoutId],
    ] as const) {
      expect((await handlers.approve(post(url, who, json), world, order)).status, `${who} ${world} ${order}`).toBe(404);
      expect((await handlers.show(get(url, who), world, order)).status).toBe(404);
    }
    expect((await handlers.approve(post(url, owner, { origin: EVIL, html: false }), worldId, checkoutId)).status).toBe(403);
    expect((await handlers.approve(post(url, null, json), worldId, checkoutId)).status).toBe(401);

    // Nothing was approved.
    expect((await call(db, "confirm_checkout", agent.apiKey, { checkout_id: checkoutId })).envelope.status).toBe(
      "AWAITING_APPROVAL",
    );
    const ok = await handlers.approve(post(url, owner, json), worldId, checkoutId);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, status: "APPROVED" });
  }, 60_000);
});
