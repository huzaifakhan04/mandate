import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "../db/client";
import { repaymentLinks } from "../db/schema";
import { scoped } from "../db/scoped";
import { executeOperation, successBody, type ExecuteOperationOptions } from "../paypal/operations";

/**
 * The after-commit half shared by every `repayment_links` row (invoice,
 * direct and — P4 Task 2 — guarantee links): executes the link's queued
 * `order.create` and copies the order id + approve URL onto it. Its own
 * module so `collections.ts` (the charge-off step) and `repayments.ts`
 * can both use it without importing each other.
 */

type LinkRow = typeof repaymentLinks.$inferSelect;

/** The public base URL for checkout return/cancel pages. */
export function checkoutUrl(path: string): string {
  const base = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
  return `${base.replace(/\/+$/, "")}${path}`;
}

/**
 * Executes a link's queued `order.create` if it hasn't produced an order
 * yet, and copies the order id + approve URL onto the link row (`pending`
 * → `open`). A terminally failed create marks the link `failed`. Never
 * call inside a transaction. Returns the link's current row.
 */
export async function refreshLinkRow(
  db: Db,
  worldId: string,
  link: LinkRow,
  options: ExecuteOperationOptions = {},
): Promise<LinkRow> {
  if (link.approveUrl || !link.createOpId) {
    return link;
  }
  const result = await executeOperation(db, link.createOpId, options);
  if (result.status === "succeeded") {
    const body = successBody(result, "order.create");
    // Copied even if a capture already settled the link (cron raced us).
    await scoped(db, worldId).update(
      repaymentLinks,
      { paypalOrderId: body.orderId, approveUrl: body.approveUrl },
      and(eq(repaymentLinks.id, link.id), isNull(repaymentLinks.approveUrl))!,
    );
    await scoped(db, worldId).update(
      repaymentLinks,
      { status: "open" },
      and(eq(repaymentLinks.id, link.id), eq(repaymentLinks.status, "pending"))!,
    );
  } else if (result.status === "failed_terminal") {
    const failed = await scoped(db, worldId).update(
      repaymentLinks,
      { status: "failed" },
      and(eq(repaymentLinks.id, link.id), eq(repaymentLinks.status, "pending"))!,
    );
    if (failed.length === 1) {
      console.error(`[repayments] order.create for ${link.kind} link ${link.id} failed terminally`);
    }
  }
  return (await scoped(db, worldId).findOne(repaymentLinks, eq(repaymentLinks.id, link.id))) ?? link;
}

/**
 * P4 Task 2: the loan's guarantee link (or `undefined`), with its
 * `order.create` executed and approve URL stored if that hasn't happened
 * yet. Called after the charge-off step commits, by the reconcile cron's
 * follow-up and lazily by views. Never call inside a transaction.
 */
export async function refreshGuaranteeLink(
  db: Db,
  worldId: string,
  loanId: string,
  options: ExecuteOperationOptions = {},
): Promise<LinkRow | undefined> {
  const link = await scoped(db, worldId).findOne(
    repaymentLinks,
    and(eq(repaymentLinks.loanId, loanId), eq(repaymentLinks.kind, "guarantee"))!,
  );
  return link ? refreshLinkRow(db, worldId, link, options) : undefined;
}
