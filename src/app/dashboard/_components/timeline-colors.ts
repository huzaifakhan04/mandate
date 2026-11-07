import type { TimelineKind } from "@/server/services/timeline";

/**
 * P7 — Timeline colours, from the light tokens in globals.css: accent
 * (planned / active), money-in (paid / repaid), amber (late / missed),
 * risk (substandard / failed), ink (charged off), muted (disbursing).
 */
export const TOKENS = {
  accent: "#1d4ed8",
  moneyIn: "#0f9d58",
  moneyInInk: "#0a7a44",
  amber: "#b26a00",
  risk: "#d93025",
  riskInk: "#8e1f17",
  ink: "#15181d",
  muted: "#5b6472",
} as const;

const LOAN: Record<string, string> = {
  disbursing: TOKENS.muted,
  active: TOKENS.accent,
  late: TOKENS.amber,
  substandard: TOKENS.risk,
  charged_off: TOKENS.ink,
  recovered: TOKENS.moneyInInk,
  repaid: TOKENS.moneyIn,
  disbursement_failed: TOKENS.muted,
};

const INSTALLMENT: Record<string, string> = {
  planned: TOKENS.accent,
  paid: TOKENS.moneyIn,
  missed: TOKENS.amber,
  failed: TOKENS.risk,
};

const LADDER: Record<string, string> = {
  late: TOKENS.amber,
  penalty: TOKENS.amber,
  substandard: TOKENS.risk,
  charged_off: TOKENS.ink,
};

export function timelineColor(kind: TimelineKind, state: string): string {
  switch (kind) {
    case "loan":
      return LOAN[state] ?? TOKENS.accent;
    case "installment":
      return INSTALLMENT[state] ?? TOKENS.accent;
    case "missed":
      return TOKENS.amber;
    case "ladder":
      return LADDER[state] ?? TOKENS.amber;
    case "repayment":
      return TOKENS.moneyInInk;
    case "guarantee":
      return TOKENS.riskInk;
  }
}

/** The legend under the timeline. */
export const TIMELINE_LEGEND: Array<{ label: string; color: string }> = [
  { label: "Loan / planned installment", color: TOKENS.accent },
  { label: "Paid", color: TOKENS.moneyIn },
  { label: "Missed / late", color: TOKENS.amber },
  { label: "Failed / substandard", color: TOKENS.risk },
  { label: "Charged off", color: TOKENS.ink },
  { label: "Repayment", color: TOKENS.moneyInInk },
  { label: "Guarantee", color: TOKENS.riskInk },
];
