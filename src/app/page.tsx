import Link from "next/link";

import { MandateMark } from "@/components/brand/MandateLogo";
import { IconArrowRight, IconIn, IconNote, IconOut } from "@/components/ui/icons";
import { LEGAL } from "@/components/ui/legal";
import { SPONSOR_LINKS } from "@/server/sponsors/links";

/** The loop, as it actually runs: one line per step and the PayPal API behind it. Static and factual. */
const STEPS = [
  {
    name: "Lend",
    Icon: IconNote,
    what: "Agents buy lender notes and earn 80% of borrower fees.",
    api: "PayPal Orders v2 checkout",
  },
  {
    name: "Borrow",
    Icon: IconOut,
    what: "Agents borrow $10–$500 for 7–30 days, inside their mandate.",
    api: "PayPal Payouts",
  },
  {
    name: "Repay",
    Icon: IconIn,
    what: "The client pays the invoice; the bank keeps principal and fee.",
    api: "Invoice payment link",
  },
] as const;

const QUIET_LINK =
  "text-t2 underline decoration-line-3 underline-offset-[3px] hover:text-t1 hover:decoration-t3";

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-1 flex-col bg-background">
      <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col px-4 sm:px-8">
        <header className="flex h-14 items-center">
          <span className="inline-flex items-center gap-2 text-[13px] font-[560] tracking-[-0.015em] text-t1">
            <MandateMark size={18} />
            <span aria-hidden="true">Mandate</span>
          </span>
        </header>

        <main className="flex flex-1 flex-col justify-center gap-8 py-10">
          <div>
            <h1 className="m-0 max-w-[600px] text-[28px] font-[560] leading-[1.12] tracking-[-0.025em] text-t1 sm:text-[36px]">
              <span className="sr-only">Mandate: </span>
              The bank for AI agents.
            </h1>
            <p className="m-0 mt-3 max-w-[560px] text-[15px] leading-normal text-t2 sm:text-[17px]">
              Agents borrow against invoices, lend for yield, and repay over PayPal — inside limits their human signs.
            </p>
          </div>

          <ol className="m-0 grid list-none grid-cols-1 border-y border-line p-0 sm:grid-cols-3">
            {STEPS.map(({ name, Icon, what, api }, i) => (
              <li
                key={name}
                className={`py-4 sm:pr-5 ${i > 0 ? "border-t border-line sm:border-t-0 sm:border-l sm:pl-5" : ""}`}
              >
                <p className="m-0 flex items-center gap-2 text-[12.5px] text-t3">
                  <Icon size={14} />
                  <b className="font-medium text-t1">{name}</b>
                  <span className="text-t4">· {i + 1} of 3</span>
                </p>
                <p className="m-0 mt-2 text-[12.5px] leading-normal text-t2">{what}</p>
                <p className="m-0 mt-1.5 font-mono text-[11.5px] text-t4">{api}</p>
              </li>
            ))}
          </ol>

          <div className="flex flex-col gap-5">
            <div>
              <Link href="/console" className="ui-btn primary lg" aria-label="Watch the bank live →">
                Watch the bank live <IconArrowRight size={14} />
              </Link>
            </div>
            <nav aria-label="Developers" className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-t3">
              <span>
                Agents: read{" "}
                <Link className={QUIET_LINK} href="/agents.md">
                  /agents.md
                </Link>
              </span>
              <a className={QUIET_LINK} href={SPONSOR_LINKS.postmanForkUrl}>
                Run in Postman
              </a>
              <Link className={QUIET_LINK} href="/sdks">
                TypeScript &amp; Python SDKs
              </Link>
              <a className={QUIET_LINK} href="/openapi.json">
                OpenAPI
              </a>
            </nav>
          </div>
        </main>

        <footer className="border-t border-line py-4">
          <p className="ui-legal m-0">{LEGAL}</p>
        </footer>
      </div>
    </div>
  );
}
