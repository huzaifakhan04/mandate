import { z } from "zod";

import { principalReasons } from "../../domain/reasons";
import { getApplicationView } from "../../services/loans";
import { fail, ok, type NextAction } from "../envelope";
import { defineTool } from "../registry";
import { adverseActionSchema, explanationSchema } from "./applyForLoan";

const inputSchema = z.object({
  application_id: z.uuid(),
});

const outputSchema = z.object({
  application_id: z.string(),
  /** An application is decided in the same transaction that records it, so it is only ever one of these. */
  status: z.enum(["OFFERED", "DECLINED"]),
  decision: z.enum(["approved", "declined"]).nullable(),
  reasons: z.array(z.object({ code: z.string(), text: z.string() })),
  adverse_action: adverseActionSchema.nullable(),
  explanation: explanationSchema.nullable(),
  offer_id: z.string().nullable(),
  ala: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string(),
});

export const getApplicationTool = defineTool({
  name: "get_application",
  title: "Get Application",
  description:
    "Returns one of the calling agent's loan applications: its status — OFFERED (the bank made an offer; " +
    "the application stays OFFERED after the offer is accepted, declined or expires, so use get_loan / " +
    "get_status for what happened next) or DECLINED (see adverse_action) — the " +
    "decision, the principal reasons [{code, text}], the adverse_action notice of a decline (your " +
    "statement of specific reasons), the latest explanation (the loan officer's text, or its template " +
    "when the AI was unavailable), the offer_id of an offered application, and an echo of the " +
    "application sections A–H (ala) as submitted. Read-only.",
  auth: "agent",
  mutating: false,
  readOnly: true,
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("get_application requires an authenticated agent");
    }
    const view = await getApplicationView(ctx.db, ctx.worldId, ctx.agentId, input.application_id);
    if (!view) {
      return fail("NOT_FOUND", "No such application.", ["application_not_found"]);
    }
    const { application, offerId } = view;
    const status = application.status.toUpperCase() === "OFFERED" ? "OFFERED" : "DECLINED";
    const narrative = application.narrative as { explanation?: unknown } | null;
    const adverse = application.adverseAction as { explanation?: unknown } | null;
    const explanation = narrative?.explanation ?? adverse?.explanation ?? null;
    const decision = application.decision === "approved" || application.decision === "declined" ? application.decision : null;
    const reasonCodes = application.reasonCodes ?? [];

    const nextActions: NextAction[] =
      status === "OFFERED" && offerId
        ? [{ tool: "get_status", args: {} }]
        : [
            {
              tool: "check_eligibility",
              args: { amount_cents: Number(application.amountCents), term_days: application.termDays },
            },
          ];

    return ok(
      {
        application_id: application.id,
        status,
        decision,
        reasons: decision === "declined" ? principalReasons(reasonCodes) : [],
        adverse_action: adverse ?? null,
        explanation,
        offer_id: offerId,
        ala: (application.sections as Record<string, unknown> | null) ?? null,
        created_at: application.createdAt.toISOString(),
      },
      {
        status: "OK",
        summary:
          decision === "declined"
            ? `Application ${status}: ${reasonCodes.join(", ")}.`
            : `Application ${status}${offerId ? ` (offer ${offerId})` : ""}.`,
        reason_codes: decision === "declined" ? reasonCodes : [],
        next_actions: nextActions,
      },
    );
  },
});
