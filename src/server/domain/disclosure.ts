import { createHash } from "crypto";

/**
 * Canonical JSON: object keys sorted (recursively), no whitespace. Arrays
 * keep their order. The input must be plain JSON (no `bigint`, `Date`,
 * `undefined`) — a disclosure is built from numbers and strings only, so
 * the hash an agent recomputes from the JSON it was shown matches ours.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  if (typeof value === "bigint" || value === undefined || typeof value === "function") {
    throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
  }
  return JSON.stringify(value);
}

/** `sha256` hex of the disclosure's canonical JSON — what `accept_offer` must echo back. */
export function disclosureHash(disclosure: unknown): string {
  return createHash("sha256").update(canonicalJson(disclosure)).digest("hex");
}
