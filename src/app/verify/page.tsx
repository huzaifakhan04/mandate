import type { Metadata } from "next";
import { Suspense } from "react";

import { sanitizeReturnTo } from "@/server/auth/session";

import { VerifyCard } from "./_components/card";

export const metadata: Metadata = {
  title: "Mandate · Verify with PayPal",
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

/** The form's hidden `return_to` (sanitized again server-side by `/verify/start`). */
async function ReturnToField({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = (await searchParams).return_to;
  return <input type="hidden" name="return_to" value={sanitizeReturnTo(typeof raw === "string" ? raw : null)} />;
}

/**
 * Sign-in for humans who own agents: "Verify with PayPal" approves a
 * $0.01 order that is never captured, so Mandate learns the PayPal
 * account (payer id + email) behind the principal.
 */
export default function VerifyPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return (
    <VerifyCard>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">Verify with PayPal</h1>
      <p className="mt-3 text-base leading-relaxed text-ink/70">
        Approve a $0.01 identity check in PayPal. It is never charged — Mandate only reads which PayPal account
        approved it.
      </p>
      <form method="post" action="/verify/start" className="mt-6">
        <Suspense fallback={null}>
          <ReturnToField searchParams={searchParams} />
        </Suspense>
        <button
          type="submit"
          className="w-full rounded-xl bg-accent px-4 py-3 text-base font-semibold text-white hover:bg-accent/90"
        >
          Verify with PayPal
        </button>
      </form>
    </VerifyCard>
  );
}
