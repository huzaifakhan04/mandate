import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthActions, AuthHeading, AuthLead, AuthShell, AuthVia } from "@/components/ui/auth-shell";
import { IconShield } from "@/components/ui/icons";
import { sanitizeReturnTo } from "@/server/auth/session";

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
    <AuthShell>
      <div>
        <AuthHeading>Verify with PayPal</AuthHeading>
        <AuthLead>
          Approve a $0.01 identity check in PayPal. It is never charged — Mandate only reads which PayPal account
          approved it.
        </AuthLead>
      </div>
      <AuthActions>
        <form method="post" action="/verify/start">
          <Suspense fallback={null}>
            <ReturnToField searchParams={searchParams} />
          </Suspense>
          <button type="submit" className="ui-btn primary lg">
            Verify with PayPal
          </button>
        </form>
      </AuthActions>
      <AuthVia>
        <IconShield size={14} />
        via PayPal · sandbox · no real money moves
      </AuthVia>
    </AuthShell>
  );
}
