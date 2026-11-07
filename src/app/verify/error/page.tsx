import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { VerifyCard } from "../_components/card";

export const metadata: Metadata = {
  title: "Mandate · Verification failed",
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

const MESSAGES: Record<string, string> = {
  cancelled: "You cancelled the PayPal check. Nothing was charged.",
  not_approved: "PayPal hasn't approved this check, so we couldn't verify you. Nothing was charged.",
  no_payer: "PayPal didn't tell us which account approved the check. Please try again.",
  unknown_order: "We don't recognise that PayPal check. Please start again.",
  session_mismatch:
    "This PayPal check was started in a different browser, or it expired. Please start again from this browser.",
  paypal_unavailable: "We couldn't reach PayPal. Please try again in a minute.",
  rate_limited: "Too many verification attempts from your network. Please try again in an hour.",
};

const FALLBACK = "Something went wrong verifying with PayPal. Please try again.";

async function Reason({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const reason = (await searchParams).reason;
  const message = (typeof reason === "string" && MESSAGES[reason]) || FALLBACK;
  return <p className="mt-3 text-base leading-relaxed text-ink/70">{message}</p>;
}

export default function VerifyErrorPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return (
    <VerifyCard>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">Not verified</h1>
      <Suspense fallback={<p className="mt-3 text-base text-ink/70">{FALLBACK}</p>}>
        <Reason searchParams={searchParams} />
      </Suspense>
      <Link
        href="/verify"
        className="mt-6 inline-block rounded-xl bg-accent px-4 py-3 text-base font-semibold text-white hover:bg-accent/90"
      >
        Try again
      </Link>
    </VerifyCard>
  );
}
