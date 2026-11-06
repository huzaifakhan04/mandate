import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";

import { requirePagePrincipal } from "@/server/auth/guard";
import { ownedAgent } from "@/server/auth/ownership";
import { REVEAL_HEADER_NAME, openReveal } from "@/server/auth/reveal";
import { MCP_CLIENTS, mcpConfigSnippets } from "@/server/contracts/docs";
import { getDb } from "@/server/db/client";

import { DashFrame, LEGAL, LoadingFrame, TopBar } from "../../../_components/chrome";
import "../../../dashboard.css";

export const metadata: Metadata = {
  title: "Mandate · Your agent's API key",
  robots: { index: false, follow: false },
};

type Params = Promise<{ id: string }>;

function publicBaseUrl(): string {
  return process.env.PUBLIC_BASE_URL || "http://localhost:3000";
}

/**
 * `/dashboard/agents/<id>/api-key` — shows a just-issued API key once
 * (after path B registration or a rotation), with MCP config for Claude
 * Code, Cursor and Codex from the same generator as agents.md. The key
 * comes only from the sealed `mandate_reveal` cookie, which `src/proxy.ts`
 * passes in as a request header and clears: a reload shows "already shown".
 */
async function ApiKeyReveal({ params }: { params: Params }) {
  const { id } = await params;
  const session = await requirePagePrincipal("/dashboard");
  const agent = await ownedAgent(await getDb(), session.principalId, id);
  const reveal = agent
    ? openReveal((await headers()).get(REVEAL_HEADER_NAME), { principalId: session.principalId, agentId: agent.id })
    : null;
  const snippets = reveal ? mcpConfigSnippets(publicBaseUrl(), reveal.apiKey) : null;

  return (
    <DashFrame>
      <TopBar principalId={session.principalId} />
      <main className="page">
        <div className="narrow">
          <Link className="crumb" href="/dashboard">
            ← Your agents
          </Link>
          {!agent ? (
            <div className="panel">
              <h1>Agent not found</h1>
              <p className="sub">That agent isn&apos;t one of yours.</p>
            </div>
          ) : !reveal || !snippets ? (
            <div className="panel" data-testid="key-already-shown">
              <h1 style={{ fontSize: 20 }}>This key was already shown</h1>
              <p className="sub" style={{ marginBottom: 14 }}>
                API keys are shown once and never stored. If you didn&apos;t save it, rotate the key for{" "}
                <b>{agent.name}</b> to get a new one (the old one stops working).
              </p>
              <Link className="btn" href={`/dashboard?agent=${agent.id}#keys`}>
                Open {agent.name}
              </Link>
            </div>
          ) : (
            <>
              <div className="head">
                <div>
                  <h1>{reveal.kind === "registered" ? `${agent.name} is registered` : `New API key for ${agent.name}`}</h1>
                  <p className="sub">
                    {reveal.kind === "registered"
                      ? "It's active and yours. Give it this key now — it's shown once and never again."
                      : "The old key has stopped working. Give your agent this one now — it's shown once and never again."}
                  </p>
                </div>
              </div>
              <section className="panel" aria-labelledby="key-h">
                <h2 id="key-h">API key</h2>
                <p>Copy it somewhere safe. Mandate keeps only a hash.</p>
                <code className="secret" data-testid="api-key">
                  {reveal.apiKey}
                </code>
              </section>
              <section className="panel" aria-labelledby="mcp-h">
                <h2 id="mcp-h">Connect your agent over MCP</h2>
                <p>Paste the config for the client your agent runs in.</p>
                {MCP_CLIENTS.map((client) => (
                  <div className="snipgroup" key={client.id}>
                    <span className="lbl">
                      {client.title}
                      {client.where ? (
                        <>
                          {" "}
                          · <span className="mono">{client.where}</span>
                        </>
                      ) : null}
                    </span>
                    <pre className="snippet" data-testid={`mcp-${client.id}`}>
                      <code>{snippets[client.id]}</code>
                    </pre>
                  </div>
                ))}
              </section>
              <section className="panel" aria-labelledby="next-h">
                <h2 id="next-h">{reveal.kind === "registered" ? "Next: sign a mandate" : "Done"}</h2>
                <p>
                  {reveal.kind === "registered"
                    ? `${agent.name} is at tier T0: it can lend now. Sign a standing mandate to let it borrow within your limits.`
                    : "Your agent should switch to the new key before its next call."}
                </p>
                <Link
                  className="btn primary"
                  href={reveal.kind === "registered" ? `/dashboard?agent=${agent.id}&edit=mandate#mandate` : `/dashboard?agent=${agent.id}`}
                >
                  {reveal.kind === "registered" ? "Sign a mandate →" : `Back to ${agent.name}`}
                </Link>
              </section>
            </>
          )}
          <p className="pagelegal">{LEGAL}</p>
        </div>
      </main>
    </DashFrame>
  );
}

export default function ApiKeyPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<LoadingFrame />}>
      <ApiKeyReveal params={params} />
    </Suspense>
  );
}
