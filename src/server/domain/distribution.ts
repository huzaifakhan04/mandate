/**
 * Pro-rata distribution with largest-remainder rounding (pure).
 *
 * Holders with `units <= 0` are dropped. Each remaining holder gets
 * `floor(amount × units / Σunits)`; the cents left over (fewer than the
 * number of holders) go one each to the holders with the largest
 * fractional remainder, ties broken by `agentId` ascending. The result is
 * sorted by `agentId` ascending (a stable, deterministic order) and always
 * sums to `amountCents`.
 *
 * Golden: units [3,3,3], amount 10 → [4,3,3] — the first agentId gets the
 * extra cent.
 */
export interface HolderUnits {
  agentId: string;
  units: bigint;
}

export interface HolderShare {
  agentId: string;
  cents: bigint;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function distribute(holderUnits: HolderUnits[], amountCents: bigint): HolderShare[] {
  if (amountCents < 0n) {
    throw new RangeError("distribute: amount must be non-negative");
  }
  if (holderUnits.some((holder) => holder.units < 0n)) {
    throw new RangeError("distribute: units must be non-negative");
  }

  const holders = holderUnits.filter((holder) => holder.units > 0n).sort((a, b) => compareIds(a.agentId, b.agentId));
  if (holders.length === 0) {
    return [];
  }
  const totalUnits = holders.reduce((sum, holder) => sum + holder.units, 0n);

  const shares = holders.map((holder) => {
    const numerator = amountCents * holder.units;
    return { agentId: holder.agentId, cents: numerator / totalUnits, fraction: numerator % totalUnits };
  });

  let leftover = amountCents - shares.reduce((sum, share) => sum + share.cents, 0n);
  const byFraction = [...shares].sort((a, b) =>
    a.fraction === b.fraction ? compareIds(a.agentId, b.agentId) : a.fraction > b.fraction ? -1 : 1,
  );
  for (const share of byFraction) {
    if (leftover === 0n) break;
    share.cents += 1n;
    leftover -= 1n;
  }

  return shares.map(({ agentId, cents }) => ({ agentId, cents }));
}
