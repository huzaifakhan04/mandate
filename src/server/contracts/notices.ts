import { z } from "zod";

/** P4 Task 1: one agent notice as `get_status` / `get_loan` show it (`noticeView` in services/collections.ts). */
export const noticeSchema = z.object({
  notice_id: z.string(),
  kind: z.string(),
  loan_id: z.string().nullable(),
  sim_at: z.string(),
  body: z.string(),
});
