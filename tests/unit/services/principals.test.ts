import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSession, readSession } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { paypalOperations, principals, worlds } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { simApprove } from "@/server/rail/simHandler";
import {
  VerificationError,
  completeVerification,
  getPrincipal,
  startVerification,
} from "@/server/services/principals";
import { createWorld, ensureMainWorldOnce } from "@/server/services/worlds";

const OWNER = { payerId: "OWNERPAYER123", email: "owner@example.com", givenName: "Olive", surname: "Owner" };

/** Tests run the main world on the sim rail (production's main world is `paypal`). */
async function simMainWorld(db: Db): Promise<string> {
  const { worldId } = await ensureMainWorldOnce(db);
  await db.update(worlds).set({ railMode: "sim" }).where(eq(worlds.id, worldId));
  return worldId;
}

describe("Verify with PayPal (sim rail)", () => {
  let db: Db;
  let mainWorldId: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("PUBLIC_BASE_URL", "https://mandate.test/");
    db = await createTestDb();
    mainWorldId = await simMainWorld(db);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates a $0.01 identity order in the main world returning to /verify/return", async () => {
    const started = await startVerification(db, { returnTo: "/dashboard" });
    expect(started.approveUrl).toContain(encodeURIComponent(started.orderId));

    const [create] = await db
      .select()
      .from(paypalOperations)
      .where(eq(paypalOperations.paypalId, started.orderId));
    expect(create).toMatchObject({
      worldId: mainWorldId,
      kind: "order.create",
      purpose: "identity_verification",
      status: "succeeded",
      rail: "sim",
    });
    const body = create!.executableRequest as {
      body: {
        purchase_units: { amount: { value: string }; description: string }[];
        payment_source: { paypal: { experience_context: { return_url: string; cancel_url: string } } };
      };
    };
    expect(body.body.purchase_units[0]).toMatchObject({
      amount: { currency_code: "USD", value: "0.01" },
      description: "Mandate identity check (not charged)",
    });
    expect(body.body.payment_source.paypal.experience_context.return_url).toBe(
      "https://mandate.test/verify/return",
    );
  });

  it("an approved order yields a principal whose session reads back", async () => {
    const { orderId } = await startVerification(db, {});
    await simApprove(db, orderId, OWNER);

    const principal = await completeVerification(db, orderId);
    expect(principal).toMatchObject({
      paypalPayerId: OWNER.payerId,
      email: OWNER.email,
      name: "Olive Owner",
    });
    expect(principal.verifiedAt).toBeInstanceOf(Date);

    const cookie = createSession(principal.id);
    expect(readSession(cookie)).toEqual({ principalId: principal.id });
    expect(await getPrincipal(db, principal.id)).toMatchObject({ id: principal.id });
  });

  it("completing the same order twice gives one principal", async () => {
    const { orderId } = await startVerification(db, {});
    await simApprove(db, orderId, OWNER);

    const first = await completeVerification(db, orderId);
    const second = await completeVerification(db, orderId);
    expect(second.id).toBe(first.id);
    expect(await db.select().from(principals)).toHaveLength(1);
  });

  it("a second verification by the same PayPal payer maps to the same principal", async () => {
    const a = await startVerification(db, {});
    await simApprove(db, a.orderId, OWNER);
    const first = await completeVerification(db, a.orderId);

    const b = await startVerification(db, {});
    await simApprove(db, b.orderId, { ...OWNER, email: "owner+new@example.com" });
    const second = await completeVerification(db, b.orderId);

    expect(second.id).toBe(first.id);
    expect(second.email).toBe("owner+new@example.com");
    expect(second.verifiedAt?.getTime()).toBe(first.verifiedAt?.getTime());
    expect(await db.select().from(principals)).toHaveLength(1);
  });

  it("never captures the order", async () => {
    const { orderId } = await startVerification(db, {});
    await simApprove(db, orderId, OWNER);
    await completeVerification(db, orderId);
    await completeVerification(db, orderId);

    const ops = await db.select().from(paypalOperations);
    expect(ops.some((op) => op.kind === "order.capture")).toBe(false);
    expect(ops.map((op) => op.kind).sort()).toEqual(["order.create", "order.get", "order.get"]);
  });

  it("rejects an order that has not been approved", async () => {
    const { orderId } = await startVerification(db, {});
    await expect(completeVerification(db, orderId)).rejects.toMatchObject({
      name: "VerificationError",
      code: "not_approved",
    });
    expect(await db.select().from(principals)).toHaveLength(0);
  });

  it("rejects unknown order ids and malformed ones", async () => {
    await expect(completeVerification(db, "SIMORDER-nope")).rejects.toMatchObject({ code: "unknown_order" });
    await expect(completeVerification(db, "bad id/../x")).rejects.toMatchObject({ code: "unknown_order" });
  });

  it("rejects an order created for another purpose or in another world", async () => {
    const other = await createWorld(db, { name: "Elsewhere", ownerPrincipalId: null, railMode: "sim" });
    const { enqueueOperation, executeOperation, buildCreateOrderRequest } = await import(
      "@/server/paypal/operations"
    );
    const { operationId } = await enqueueOperation(db, {
      worldId: other.worldId,
      rail: "sim",
      kind: "order.create",
      purpose: "identity_verification",
      sourceId: "elsewhere",
      request: buildCreateOrderRequest({
        amountCents: 1n,
        description: "x",
        customId: "elsewhere",
        returnUrl: "https://x/r",
        cancelUrl: "https://x/c",
      }),
    });
    const result = await executeOperation(db, operationId, { ignoreBackoff: true });
    const orderId = (result.body as { orderId: string }).orderId;
    await simApprove(db, orderId, OWNER);
    await expect(completeVerification(db, orderId)).rejects.toBeInstanceOf(VerificationError);
    await expect(completeVerification(db, orderId)).rejects.toMatchObject({ code: "unknown_order" });
  });
});
