import { z } from "zod";

import type { ScoreResult } from "../domain/scorecard";

/** The Agent Credit Score as `get_status` / `check_eligibility` show it (P3 Task 1). */
export const creditSchema = z.object({
  /** 0–100. */
  score: z.number(),
  /** A ≥ 80, B ≥ 65, C ≥ 50, D ≥ 35, E < 35 (E declines). */
  grade: z.enum(["A", "B", "C", "D", "E"]),
  /** The grade's per-loan limit in cents (A 50000, B 30000, C 20000, D 10000, E 0). */
  limit_cents: z.number(),
  /** Points per component: identity /25, history /35, tenure /10, collateral /20, exposure /10. */
  components: z.object({
    identity: z.number(),
    history: z.number(),
    tenure: z.number(),
    collateral: z.number(),
    exposure: z.number(),
  }),
  /** The three components costing the most points, in plain words. */
  factors: z.array(z.string()),
});

export type CreditView = z.infer<typeof creditSchema>;

export function creditView(result: ScoreResult): CreditView {
  return {
    score: result.score,
    grade: result.grade,
    limit_cents: result.limitCents,
    components: { ...result.components },
    factors: [...result.factors],
  };
}
