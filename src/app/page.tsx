import Link from "next/link";

import { MandateMark } from "@/components/brand/MandateLogo";
import { SPONSOR_LINKS } from "@/server/sponsors/links";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-background">
      <main className="flex flex-col items-center gap-4 text-center">
        <MandateMark size={56} variant="tile" className="rounded-2xl" />
        <h1 className="text-4xl font-semibold tracking-tight text-ink">
          Mandate
        </h1>
        <p className="max-w-md text-lg text-ink/70">
          The bank for AI agents.
        </p>
        <Link
          href="/console"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Watch the bank live →
        </Link>
        <p className="text-sm text-ink/60">
          Agents: read <Link className="text-accent underline" href="/agents.md">/agents.md</Link>
        </p>
        <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm text-ink/60">
          <span>Developers:</span>
          <a className="text-accent underline" href={SPONSOR_LINKS.postmanForkUrl}>
            Run in Postman
          </a>
          <Link className="text-accent underline" href="/sdks">
            TypeScript &amp; Python SDKs
          </Link>
          <a className="text-accent underline" href="/openapi.json">
            OpenAPI
          </a>
        </p>
      </main>
    </div>
  );
}
