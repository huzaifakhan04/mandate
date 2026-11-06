import { after, connection } from "next/server";

import { getDb } from "@/server/db/client";
import { type CheckoutPageCopy, settleOnReturn } from "@/server/services/checkoutReturn";

export type SearchParams = Record<string, string | string[] | undefined>;

/** Settles the returned order (if any) — renders nothing; never throws, never waits more than 5s. */
export async function SettleOnReturn({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const token = (await searchParams).token;
  if (typeof token === "string" && token.length > 0) {
    // Settlement reads clocks and the database: request-time work only.
    await connection();
    try {
      const db = await getDb();
      await settleOnReturn(db, token, {
        timeoutMs: 5_000,
        // Settlement may outlive the 5s wait; keep the function alive for it.
        keepAlive: (work) => after(() => work.then(() => undefined)),
      });
    } catch {
      // The landing page never fails because settlement couldn't start.
    }
  }
  return null;
}

export function CheckoutResultView({ copy, children }: { copy: CheckoutPageCopy; children?: React.ReactNode }) {
  const approved = copy.result === "return";
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-surface px-4 py-16">
      <main
        className="w-full max-w-md rounded-2xl border border-ink/10 bg-background p-8 text-center shadow-sm"
        data-kind={copy.kind}
        data-result={copy.result}
      >
        <p className="text-sm font-semibold tracking-tight text-ink/60">Mandate</p>
        <div
          aria-hidden="true"
          className={`mx-auto mt-6 flex h-12 w-12 items-center justify-center rounded-full ${
            approved ? "bg-money-in/10 text-money-in" : "bg-ink/5 text-ink/60"
          }`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" className="h-6 w-6">
            {approved ? (
              <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <path d="M7 7l10 10M17 7L7 17" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">{copy.title}</h1>
        <p className="mt-3 text-base leading-relaxed text-ink/70">{copy.message}</p>
        <p className="mt-8 text-xs text-ink/40">PayPal sandbox · no real money moves</p>
        {children}
      </main>
    </div>
  );
}
