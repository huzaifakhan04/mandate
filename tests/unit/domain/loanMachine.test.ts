import { describe, expect, it } from "vitest";

import {
  canTransition,
  fromDbStatus,
  InvalidTransitionError,
  LOAN_STATES,
  type LoanEvent,
  type LoanState,
  toDbStatus,
  transition,
} from "@/server/domain/loanMachine";

const VALID: Array<[LoanState, LoanEvent, LoanState]> = [
  ["SUBMITTED", "OFFER", "OFFERED"],
  ["SUBMITTED", "DECLINE", "DECLINED"],
  ["OFFERED", "ACCEPT", "ACCEPTED"],
  ["OFFERED", "DECLINE_OFFER", "DECLINED_BY_AGENT"],
  ["OFFERED", "EXPIRE", "EXPIRED"],
  ["ACCEPTED", "DISBURSE", "DISBURSING"],
  ["DISBURSING", "PAYOUT_SUCCEEDED", "ACTIVE"],
  ["DISBURSING", "PAYOUT_FAILED", "DISBURSEMENT_FAILED"],
  ["ACTIVE", "REPAY", "REPAID"],
];

const EVENTS: LoanEvent[] = [
  "OFFER",
  "DECLINE",
  "ACCEPT",
  "DECLINE_OFFER",
  "EXPIRE",
  "DISBURSE",
  "PAYOUT_SUCCEEDED",
  "PAYOUT_FAILED",
  "REPAY",
];

describe("loanMachine", () => {
  it.each(VALID)("%s --%s--> %s", (from, event, to) => {
    expect(transition(from, event)).toBe(to);
    expect(canTransition(from, event)).toBe(true);
  });

  it("every other (state, event) pair throws InvalidTransitionError", () => {
    const valid = new Set(VALID.map(([from, event]) => `${from}:${event}`));
    let invalidCount = 0;
    for (const state of LOAN_STATES) {
      for (const event of EVENTS) {
        if (valid.has(`${state}:${event}`)) continue;
        invalidCount += 1;
        expect(canTransition(state, event)).toBe(false);
        expect(() => transition(state, event)).toThrow(InvalidTransitionError);
      }
    }
    expect(invalidCount).toBe(LOAN_STATES.length * EVENTS.length - VALID.length);
  });

  it("terminal states accept no events", () => {
    for (const state of ["DECLINED", "DECLINED_BY_AGENT", "EXPIRED", "DISBURSEMENT_FAILED", "REPAID"] as const) {
      for (const event of EVENTS) {
        expect(() => transition(state, event)).toThrow(InvalidTransitionError);
      }
    }
  });

  it("InvalidTransitionError carries the state and event", () => {
    try {
      transition("ACTIVE", "ACCEPT");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      expect((err as InvalidTransitionError).state).toBe("ACTIVE");
      expect((err as InvalidTransitionError).event).toBe("ACCEPT");
    }
  });

  it("maps to and from the lowercase DB vocabulary (Ruling E)", () => {
    expect(toDbStatus("DISBURSEMENT_FAILED")).toBe("disbursement_failed");
    expect(fromDbStatus("declined_by_agent")).toBe("DECLINED_BY_AGENT");
    expect(() => fromDbStatus("pending")).toThrow();
  });
});

describe("M10: one OPEN_LOAN_DB_STATUSES constant", () => {
  it("matches the loans_one_open_per_agent_idx partial-index predicate in schema.ts", async () => {
    const { readFileSync } = await import("fs");
    const { OPEN_LOAN_DB_STATUSES } = await import("@/server/domain/loanMachine");
    const schemaSource = readFileSync("src/server/db/schema.ts", "utf8");
    const predicate = `in (${OPEN_LOAN_DB_STATUSES.map((s) => `'${s}'`).join(", ")})`;
    expect(schemaSource).toContain(predicate);
  });

  it("is the only open-loan status list in services (no private copies)", async () => {
    const { readFileSync } = await import("fs");
    for (const file of ["src/server/services/agents.ts", "src/server/services/loans.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/OPEN_LOAN_STATUSES\s*=/);
      expect(source).toContain("OPEN_LOAN_DB_STATUSES");
    }
  });
});
