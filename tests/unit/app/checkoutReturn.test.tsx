import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CheckoutResultPage, { generateStaticParams } from "@/app/checkout/[kind]/[result]/page";
import { CheckoutResultView } from "@/app/checkout/[kind]/[result]/checkout-result";
import type { Db } from "@/server/db/client";
import { createTestDb } from "@/server/db/testing";
import { simApprove } from "@/server/rail/simHandler";
import { checkoutPageCopy, settleOnReturn } from "@/server/services/checkoutReturn";
import { notePositions } from "@/server/db/schema";

import { call, createSimWorld, createTestAgent, type Data } from "../../helpers/world";

const KINDS = ["notes", "invoice", "repay"] as const;

function props(kind: string, result: string, search: Record<string, string> = {}) {
  return { params: Promise.resolve({ kind, result }), searchParams: Promise.resolve(search) };
}

/** Finds the first element in `node`'s tree whose type is `type`. */
function findElement(node: ReactNode, type: unknown): ReactElement | null {
  if (!isValidElement(node)) {
    return null;
  }
  if (node.type === type) {
    return node;
  }
  const children = (node.props as { children?: ReactNode }).children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElement(child, type);
    if (found) {
      return found;
    }
  }
  return null;
}

describe("I3: /checkout/{kind}/{result} pages", () => {
  it("prerenders all six kind × result pages", () => {
    expect(generateStaticParams()).toHaveLength(6);
  });

  for (const kind of KINDS) {
    it(`${kind}/return and ${kind}/cancel render their copy`, async () => {
      for (const result of ["return", "cancel"]) {
        const page = await CheckoutResultPage(props(kind, result));
        const view = findElement(page, CheckoutResultView);
        expect(view).not.toBeNull();
        const html = renderToStaticMarkup(<CheckoutResultView copy={(view!.props as { copy: never }).copy} />);
        expect(html).toContain(`data-kind="${kind}"`);
        if (result === "cancel") {
          expect(html).toContain("Payment cancelled. Nothing was charged.");
        } else if (kind === "invoice") {
          expect(html).toContain("Thanks — your payment to Mandate is being processed.");
        } else {
          expect(html).toContain(
            "Payment approved. You can close this tab — your agent will see it settle within a minute or two.",
          );
        }
        // Only a return landing tries to settle the order.
        const children = (page.props as { children?: ReactNode }).children;
        expect(children ? "settles" : "static").toBe(result === "return" ? "settles" : "static");
      }
    });
  }

  it("unknown kind or result → 404 (notFound)", async () => {
    await expect(CheckoutResultPage(props("loans", "return"))).rejects.toThrow();
    await expect(CheckoutResultPage(props("notes", "done"))).rejects.toThrow();
    expect(checkoutPageCopy("loans", "return")).toBeNull();
    expect(checkoutPageCopy("notes", "done")).toBeNull();
  });
});

describe("I3: settleOnReturn (world resolution + settle call)", () => {
  let db: Db;

  beforeEach(async () => {
    process.env.API_KEY_PEPPER = "test-pepper";
    db = await createTestDb();
  });

  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
    vi.restoreAllMocks();
  });

  async function approvedNoteOrder() {
    const worldId = await createSimWorld(db);
    const lender = await createTestAgent(db, worldId, "lender@example.com");
    const buy = await call(db, "buy_notes", lender.key, { amount_cents: 5000 });
    const orderId = (buy.envelope.data as Data).checkout_id as string;
    return { worldId, orderId };
  }

  it("resolves the order's world from its order.create operation and settles it (approved → credited)", async () => {
    const { worldId, orderId } = await approvedNoteOrder();
    await simApprove(db, orderId);
    let kept: Promise<unknown> | null = null;
    const outcome = await settleOnReturn(db, orderId, { keepAlive: (work) => (kept = work) });
    expect(outcome).toEqual({ status: "settled", checkoutStatus: "COMPLETED" });
    expect(kept).not.toBeNull();
    const positions = await db.select().from(notePositions);
    expect(positions.find((p) => p.worldId === worldId)?.units).toBe(5000n);
  });

  it("calls settleCheckoutByOrderId with the resolved world and order id", async () => {
    const { worldId, orderId } = await approvedNoteOrder();
    const settle = vi.fn(async () => ({ status: "AWAITING_APPROVAL" }) as never);
    const outcome = await settleOnReturn(db, orderId, { settle });
    expect(settle).toHaveBeenCalledWith(db, worldId, orderId);
    expect(outcome).toEqual({ status: "settled", checkoutStatus: "AWAITING_APPROVAL" });
  });

  it("unknown order → unknown_order; malformed token → invalid_token (no lookup)", async () => {
    const settle = vi.fn();
    expect(await settleOnReturn(db, "NOPE-123", { settle })).toEqual({ status: "unknown_order" });
    expect(await settleOnReturn(db, "x'; drop table", { settle })).toEqual({ status: "invalid_token" });
    expect(settle).not.toHaveBeenCalled();
  });

  it("a settle error is swallowed (logged without details) → error", async () => {
    const { orderId } = await approvedNoteOrder();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await settleOnReturn(db, orderId, {
      settle: async () => {
        throw new Error("boom");
      },
    });
    expect(outcome).toEqual({ status: "error" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("never waits past the timeout; the settlement keeps running via keepAlive", async () => {
    const { orderId } = await approvedNoteOrder();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    let kept: Promise<unknown> | null = null;
    const started = Date.now();
    const outcome = await settleOnReturn(db, orderId, {
      timeoutMs: 50,
      keepAlive: (work) => (kept = work),
      settle: async () => {
        await slow;
        return { status: "COMPLETED" } as never;
      },
    });
    expect(outcome).toEqual({ status: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
    release();
    await expect(kept).resolves.toEqual({ status: "settled", checkoutStatus: "COMPLETED" });
  });
});
