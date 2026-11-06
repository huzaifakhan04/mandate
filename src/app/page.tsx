import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-background">
      <main className="flex flex-col items-center gap-4 text-center">
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
      </main>
    </div>
  );
}
