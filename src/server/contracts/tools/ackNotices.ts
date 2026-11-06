import { z } from "zod";

import { ok } from "../envelope";
import { defineTool } from "../registry";
import { ackNotices } from "../../services/collections";

const inputSchema = z.strictObject({
  notice_ids: z.array(z.uuid()).min(1).max(100).optional(),
});

const outputSchema = z.object({ acknowledged: z.number() });

/**
 * P4 Task 1: marks the calling agent's notices read, so `get_status`
 * stops listing them. Allowed for a restricted or frozen agent too (it
 * moves no money and borrows nothing — see runTool's HOUSEKEEPING_TOOLS).
 */
export const ackNoticesTool = defineTool({
  name: "ack_notices",
  title: "Acknowledge Notices",
  description:
    "Marks the calling agent's notices (late fee, rate penalty, substandard, cured — listed by " +
    "get_status and get_loan) as read. Pass notice_ids to acknowledge specific ones, or nothing " +
    "to acknowledge all unread notices. It changes nothing about the loan or what is owed.",
  auth: "agent",
  mutating: true,
  readOnly: false,
  input: inputSchema,
  output: outputSchema,
  handler: async (input, ctx) => {
    if (!ctx.agentId) {
      throw new Error("ack_notices requires an authenticated agent");
    }
    const acknowledged = await ackNotices(ctx.tx, ctx.worldId, ctx.agentId, input.notice_ids ?? null, new Date());
    return ok(
      { acknowledged },
      {
        status: "OK",
        summary: `${acknowledged} notice(s) acknowledged.`,
        next_actions: [{ tool: "get_status", args: {} }],
      },
    );
  },
});
