import { eq } from "drizzle-orm";

import { runRole } from "../ai/run";
import { cleanList } from "../ai/sanitize";
import type { Db } from "../db/client";
import { kyaDocuments } from "../db/schema";
import { scoped } from "../db/scoped";
import { loadAgentKya } from "./kya";

/**
 * The KYA desk (P3 Task 4) — an AFTER-COMMIT module (listed in
 * `AI_CALLERS`, tests/unit/ai/noTransactionCalls.test.ts). The dashboard
 * upload route schedules it with `after()`, once the response is sent; it
 * takes a plain `db` and never opens a transaction.
 *
 * Advisory only: it stores the LLM's verdict and findings on the document
 * (`ai_verdict`, `ai_findings`); the P2 auto-review (`review_status`) stays
 * authoritative. Findings can echo agent-controlled strings (file name,
 * agent name), so URLs are stripped and each is capped at 200 chars.
 */
export async function reviewKyaDocument(db: Db, worldId: string, documentId: string): Promise<void> {
  try {
    const world = scoped(db, worldId);
    const [doc] = await world.selectFields(
      kyaDocuments,
      {
        id: kyaDocuments.id,
        agentId: kyaDocuments.agentId,
        kind: kyaDocuments.kind,
        fileName: kyaDocuments.fileName,
        contentType: kyaDocuments.contentType,
        sizeBytes: kyaDocuments.sizeBytes,
        reviewStatus: kyaDocuments.reviewStatus,
      },
      eq(kyaDocuments.id, documentId),
    );
    if (!doc) {
      return;
    }
    const { agent, tier } = await loadAgentKya(db, worldId, doc.agentId);

    const run = await runRole(
      db,
      worldId,
      "kya_desk",
      {
        agent: { name: agent.name.slice(0, 500), operator: agent.operator.slice(0, 500), tier: tier.tier },
        document: {
          kind: doc.kind,
          fileName: doc.fileName,
          contentType: doc.contentType,
          sizeBytes: doc.sizeBytes,
          autoReviewStatus: doc.reviewStatus,
        },
      },
      { subject: doc.id },
    );
    await scoped(db, worldId).update(
      kyaDocuments,
      { aiVerdict: run.output.verdict, aiFindings: cleanList(run.output.findings) },
      eq(kyaDocuments.id, doc.id),
    );
  } catch (err) {
    console.error(`[kya-desk] review failed for ${documentId}: ${err instanceof Error ? err.name : "error"}`);
  }
}
