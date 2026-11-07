import Link from "next/link";

import { MandateMark } from "@/components/brand/MandateLogo";

import { LEGAL } from "./legal";

/**
 * The narrow, centred column the verify, claim and checkout pages share:
 * the flat mark (linking home) on top, the legal line at the bottom, and
 * structure from spacing and hairlines only (no card, no shadow).
 */
export function AuthShell({ children, ...rest }: { children: React.ReactNode } & React.ComponentProps<"main">) {
  return (
    <div className="flex flex-1 justify-center bg-background px-4 py-8 sm:py-[72px]">
      <main {...rest} className="flex w-full max-w-[400px] flex-col gap-5">
        <Link
          href="/"
          aria-label="Mandate home"
          className="inline-flex items-center gap-2 self-start rounded text-[13px] font-[560] tracking-[-0.015em] text-t1 no-underline"
        >
          <MandateMark size={16} />
          <span aria-hidden="true">Mandate</span>
        </Link>
        {children}
        <p className="ui-legal mt-6">{LEGAL}</p>
      </main>
    </div>
  );
}

export function AuthHeading({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h1 id={id} className="m-0 text-xl font-[560] leading-tight tracking-[-0.015em] text-t1">
      {children}
    </h1>
  );
}

export function AuthLead({ children }: { children: React.ReactNode }) {
  return <p className="m-0 mt-2 text-[13.5px] leading-[1.55] text-t2">{children}</p>;
}

/** The quiet "via PayPal · sandbox" line under an auth action. */
export function AuthVia({ children }: { children: React.ReactNode }) {
  return <p className="m-0 flex items-center gap-2 text-xs text-t4">{children}</p>;
}

/** Primary/secondary action row: buttons size to content, full width below 480px. */
export function AuthActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-4 max-[479px]:[&>*]:w-full max-[479px]:[&_.ui-btn]:w-full max-[479px]:[&_.ui-btn]:justify-center">
      {children}
    </div>
  );
}
