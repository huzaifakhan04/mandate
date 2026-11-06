import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { CHECKOUT_KINDS, CHECKOUT_RESULTS, checkoutPageCopy } from "@/server/services/checkoutReturn";

import { CheckoutResultView, type SearchParams, SettleOnReturn } from "./checkout-result";

/**
 * I3 (final review): where PayPal sends the payer after approving
 * (`return`) or abandoning (`cancel`) a checkout — a note purchase
 * (`notes`), an invoice payment (`invoice`) or a direct repayment
 * (`repay`). The copy is static (prerendered for all six pages); on
 * `return?token=<orderId>` a Suspense-wrapped server component also
 * settles the order right away (waiting at most 5s), so the agent sees it
 * settled sooner than the webhook/cron would.
 */

type Params = { kind: string; result: string };

export function generateStaticParams(): Params[] {
  return CHECKOUT_KINDS.flatMap((kind) => CHECKOUT_RESULTS.map((result) => ({ kind, result })));
}

// Reached only by PayPal's redirect, never an in-app <Link>, so instant
// navigation validation (which flags the Suspense-wrapped searchParams read)
// doesn't apply.
export const instant = false;

export const metadata: Metadata = {
  title: "Mandate · Checkout",
  robots: { index: false, follow: false },
};

export default async function CheckoutResultPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<SearchParams>;
}) {
  const { kind, result } = await params;
  const copy = checkoutPageCopy(kind, result);
  if (!copy) {
    notFound();
  }

  return (
    <CheckoutResultView copy={copy}>
      {copy.result === "return" ? (
        <Suspense fallback={null}>
          <SettleOnReturn searchParams={searchParams} />
        </Suspense>
      ) : null}
    </CheckoutResultView>
  );
}
