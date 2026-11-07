import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AuthActions, AuthHeading, AuthShell, AuthVia } from "@/components/ui/auth-shell";

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

const LEAD = "m-0 mt-2 text-[13.5px] leading-[1.55] text-t2";

async function Reason({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const reason = (await searchParams).reason;
  const message = (typeof reason === "string" && MESSAGES[reason]) || FALLBACK;
  return <p className={LEAD}>{message}</p>;
}

export default function VerifyErrorPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return (
    <AuthShell>
      <div>
        <AuthHeading>Not verified</AuthHeading>
        <Suspense fallback={<p className={LEAD}>{FALLBACK}</p>}>
          <Reason searchParams={searchParams} />
        </Suspense>
      </div>
      <AuthActions>
        <Link href="/verify" className="ui-btn primary lg">
          Try again
        </Link>
      </AuthActions>
      <AuthVia>via PayPal · sandbox · no real money moves</AuthVia>
    </AuthShell>
  );
}
