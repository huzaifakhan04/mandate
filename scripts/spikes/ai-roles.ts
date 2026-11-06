/**
 * Spike (P3 Task 3): one real OpenAI Responses call per AI role through
 * `runRole` (structured outputs, strict JSON schema), against an in-memory
 * PGlite db — never Neon. Prints model, latency, token usage, whether the
 * template fallback was used, and the output. Never prints the key.
 *
 * Run: npx tsx --env-file=.env.local scripts/spikes/ai-roles.ts
 */
import { eq } from "drizzle-orm";

import { modelFor } from "@/server/ai/client";
import { runRole } from "@/server/ai/run";
import type { AiRole, KyaDeskInput, LoanOfficerInput, RiskOfficerInput } from "@/server/ai/schemas";
import { aiRuns } from "@/server/db/schema";
import { principalReasons } from "@/server/domain/reasons";
import { safeJson, spikeDb } from "./_helpers";

const loanOfficer: LoanOfficerInput = {
  decision: "decline",
  reasons: principalReasons(["insufficient_credit_history", "declaration_missing"]),
  score: 20,
  grade: "E",
  scoreFactors: ["No on-time repayment history yet.", "No collateral offered.", "Short tenure."],
  amountCents: 10000,
  termDays: 14,
  feeCents: null,
  aprBps: null,
  effectiveCapCents: 0,
};

const riskOfficer: RiskOfficerInput = {
  decision: "decline",
  approval: "manual_review_declined",
  reasons: principalReasons(["manual_review_declined"]),
  score: 40,
  grade: "D",
  components: { identity: 18, history: 0, tenure: 2, collateral: 20, exposure: 0 },
  scoreFactors: ["No on-time repayment history yet.", "High exposure versus mandate."],
  amountCents: 8000,
  termDays: 21,
  invoiceCoverageBps: 15000,
};

const kyaDesk: KyaDeskInput = {
  agent: { name: "Invoice Bot", operator: "acme-labs", tier: 1 },
  document: {
    kind: "id_document",
    fileName: "operator-license.pdf",
    contentType: "application/pdf",
    sizeBytes: 182_311,
    autoReviewStatus: "approved",
  },
};

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set (load .env.local with --env-file)");
  }
  const { db, worldId } = await spikeDb();
  const cases: Array<[AiRole, LoanOfficerInput | RiskOfficerInput | KyaDeskInput]> = [
    ["kya_desk", kyaDesk],
    ["loan_officer", loanOfficer],
    ["risk_officer", riskOfficer],
  ];
  for (const [role, input] of cases) {
    const result = await runRole(db, worldId, role, input as never, { subject: `spike-${role}` });
    const [row] = await db.select().from(aiRuns).where(eq(aiRuns.id, result.aiRunId));
    console.log(
      safeJson(
        {
          role,
          model: modelFor(role),
          latencyMs: row?.latencyMs,
          tokensIn: row?.tokensIn,
          tokensOut: row?.tokensOut,
          fallbackUsed: result.fallbackUsed,
          errorCode: result.errorCode,
          output: result.output,
        },
        2,
      ),
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
