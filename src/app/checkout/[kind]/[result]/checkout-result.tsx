import { after, connection } from "next/server";

import { AuthHeading, AuthLead, AuthShell, AuthVia } from "@/components/ui/auth-shell";
import { IconCheck, IconX } from "@/components/ui/icons";
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
    <AuthShell data-kind={copy.kind} data-result={copy.result}>
      <div>
        <span
          aria-hidden="true"
          className={`mb-4 grid size-7 place-items-center rounded-full border border-line-2 ${
            approved ? "text-money-in" : "text-risk"
          }`}
        >
          {approved ? <IconCheck size={14} /> : <IconX size={14} />}
        </span>
        <AuthHeading>{copy.title}</AuthHeading>
        <AuthLead>{copy.message}</AuthLead>
      </div>
      <AuthVia>via PayPal · sandbox · no real money moves</AuthVia>
      {children}
    </AuthShell>
  );
}
