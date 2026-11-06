import type { Metadata } from "next";
import { Suspense } from "react";

import { requirePagePrincipal } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { getPrincipal } from "@/server/services/principals";

import { VerifyCard } from "../verify/_components/card";

export const metadata: Metadata = {
  title: "Mandate · Dashboard",
  robots: { index: false, follow: false },
};

/** Placeholder until P2 Task 5 builds the owner dashboard: shows who is signed in. */
async function SignedIn() {
  const session = await requirePagePrincipal("/dashboard");
  const principal = await getPrincipal(await getDb(), session.principalId);
  return (
    <>
      <p className="mt-3 text-base leading-relaxed text-ink/70" data-testid="principal-email">
        Signed in as {principal?.email ?? "an unknown principal"}
      </p>
      <form method="post" action="/logout" className="mt-6">
        <button
          type="submit"
          className="w-full rounded-xl border border-ink/15 px-4 py-3 text-base font-semibold text-ink hover:bg-surface"
        >
          Sign out
        </button>
      </form>
    </>
  );
}

export default function DashboardPage() {
  return (
    <VerifyCard>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">Dashboard</h1>
      <Suspense fallback={null}>
        <SignedIn />
      </Suspense>
    </VerifyCard>
  );
}
