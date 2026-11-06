import { simCaptureFeeCents } from "@/server/rail/simHandler";

/**
 * Task 10b: the sim rail's simulated PayPal fees, for tests that assert
 * exact cash/liquidity. (Ruling W's per-world seed capital — 10000 by
 * default — covers these fees, so no test needs to add capital itself.)
 */

/** The sim rail's simulated capture fee for `amountCents` (2.9% half-up + 30¢). */
export function simCaptureFee(amountCents: number | bigint): bigint {
  return simCaptureFeeCents(BigInt(amountCents));
}

/** The sim rail's simulated fee for one SUCCESS payout item. */
export const SIM_PAYOUT_FEE = 25n;
