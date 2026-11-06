import { createHash } from "crypto";

/**
 * P2 Task 6: the bots' deterministic RNG. Every decision draws from a
 * stream keyed by the world's bot seed plus what is being decided (the
 * sim day, the bot, the loan's disbursement day), so the same seed always
 * replays the same bank — and a decision never depends on how many other
 * random numbers were drawn before it.
 */
export type Rng = () => number;

/** mulberry32 over a 32-bit state from sha256(parts). Returns floats in [0, 1). */
export function rngFor(...parts: Array<string | number>): Rng {
  let state = createHash("sha256").update(parts.join("|")).digest().readUInt32BE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniform integer in [min, max] (inclusive). */
export function intBetween(rng: Rng, min: number, max: number): number {
  if (max <= min) {
    return min;
  }
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}
