import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { requirePagePrincipal } from "@/server/auth/guard";

import { DashFrame, LEGAL, LoadingFrame, TopBar } from "../../_components/chrome";
import "../../dashboard.css";

export const metadata: Metadata = {
  title: "Mandate · Register an agent",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const FIELD_ERRORS: Record<string, string> = {
  name: "Give the agent a name (2–60 characters).",
  operator: "Who runs this agent? (1–80 characters)",
  model: "Which model does it run on? (1–80 characters)",
  payout: "Enter a PayPal email address or a 13-character PayPal account ID.",
};

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `/dashboard/agents/new` — onboarding path B: the human registers an
 * agent here. It is created already claimed by them (active, tier T0
 * until they sign a mandate); the next page shows its API key once.
 */
async function RegisterForm({ searchParams }: { searchParams: SearchParams }) {
  const session = await requirePagePrincipal("/dashboard/agents/new");
  const params = await searchParams;
  const errors = new Set((one(params.fields) ?? "").split(",").filter(Boolean));
  const failed = one(params.error);
  const field = (name: string) => ({
    "aria-invalid": errors.has(name) ? ("true" as const) : undefined,
    "aria-describedby": errors.has(name) ? `err-${name}` : `hint-${name}`,
  });
  const err = (name: string) =>
    errors.has(name) ? (
      <span className="err" id={`err-${name}`}>
        {FIELD_ERRORS[name]}
      </span>
    ) : null;

  return (
    <DashFrame>
      <TopBar principalId={session.principalId} />
      <main className="page">
        <div className="narrow">
          <Link className="crumb" href="/dashboard">
            ← Your agents
          </Link>
          <div className="head">
            <div>
              <h1>Register an agent</h1>
              <p className="sub">
                The agent is yours from the start: it can lend right away, and borrows once you sign a mandate for
                it. You&apos;ll get its API key on the next screen.
              </p>
            </div>
          </div>
          {failed ? (
            <div className="notice err" role="alert">
              {failed === "invalid" ? "Check the highlighted fields." : "Something went wrong. Please try again."}
            </div>
          ) : null}
          <form className="panel" method="post" action="/dashboard/agents" style={{ display: "grid", gap: 14 }}>
            <div className="field">
              <label htmlFor="r-name">Agent name</label>
              <input
                className="input"
                id="r-name"
                name="name"
                required
                minLength={2}
                maxLength={60}
                placeholder="Nova"
                defaultValue={one(params.name)}
                {...field("name")}
              />
              <span className="hint" id="hint-name">
                What you call it on this dashboard.
              </span>
              {err("name")}
            </div>
            <div className="fields">
              <div className="field">
                <label htmlFor="r-operator">Operator</label>
                <input
                  className="input"
                  id="r-operator"
                  name="operator"
                  required
                  maxLength={80}
                  placeholder="Studio LLC"
                  defaultValue={one(params.operator)}
                  {...field("operator")}
                />
                <span className="hint" id="hint-operator">
                  The person or company running it.
                </span>
                {err("operator")}
              </div>
              <div className="field">
                <label htmlFor="r-model">Model</label>
                <input
                  className="input"
                  id="r-model"
                  name="model"
                  required
                  maxLength={80}
                  placeholder="Claude"
                  defaultValue={one(params.model)}
                  {...field("model")}
                />
                <span className="hint" id="hint-model">
                  The model it runs on.
                </span>
                {err("model")}
              </div>
            </div>
            <div className="field">
              <label htmlFor="r-payout">Payout PayPal account</label>
              <input
                className="input"
                id="r-payout"
                name="payout"
                required
                autoComplete="off"
                placeholder="agent@example.com or PayPal account ID"
                {...field("payout")}
              />
              <span className="hint" id="hint-payout">
                Where its loans and note redemptions are paid: a PayPal sandbox email, or a 13-character account ID.
              </span>
              {err("payout")}
            </div>
            <button type="submit" className="btn primary block">
              Register agent
            </button>
          </form>
          <p className="pagelegal">{LEGAL}</p>
        </div>
      </main>
    </DashFrame>
  );
}

export default function RegisterAgentPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<LoadingFrame />}>
      <RegisterForm searchParams={searchParams} />
    </Suspense>
  );
}
