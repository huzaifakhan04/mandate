import { createHash } from "crypto";

/**
 * Namespace UUID for every derived `paypal_operations.id` in this
 * codebase (Global Constraints, P1 SDD). Fixed and never changed —
 * changing it would re-derive every existing operation id.
 */
export const OPERATION_ID_NAMESPACE = "6f1c2a9e-5b7d-4c3e-9a1f-2d8e7b6c5a40";

/**
 * The finite set of reasons a `paypal_operations` row was enqueued.
 * Paired with a `sourceId` (e.g. a note/loan/repayment id) via
 * `journalKey`, this is also the ledger idempotency key for the
 * corresponding journal entry — the same logical operation always
 * produces the same operation id AND the same journal key.
 */
export type OperationPurpose =
  | "note_purchase"
  | "note_redemption"
  | "loan_disbursement"
  | "repayment_link"
  | "repayment_direct"
  | "repayment_capture"
  | "note_purchase_capture"
  | "remainder_payout"
  | "payout_cancel";

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * RFC 4122 UUIDv5 (namespace + SHA-1), implemented directly on
 * `node:crypto` rather than pulling in the `uuid` package — this is the
 * only thing this module needs from it.
 */
function uuidV5(namespace: string, name: string): string {
  const hash = createHash("sha1")
    .update(Buffer.concat([uuidBytes(namespace), Buffer.from(name, "utf8")]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // Version 5: top nibble of byte 6 is 0b0101.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  // Variant: top two bits of byte 8 are 0b10.
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  return formatUuid(bytes);
}

/**
 * The ledger idempotency key for a logical operation: identical for
 * every attempt of the same `purpose`/`sourceId` pair, distinct across
 * purposes even for the same `sourceId` (e.g. a loan's disbursement vs.
 * its repayment capture never collide).
 */
export function journalKey(purpose: OperationPurpose, sourceId: string): string {
  return `${purpose}:${sourceId}`;
}

/**
 * Deterministically derives a `paypal_operations.id` (and therefore the
 * `PayPal-Request-Id` sent for it) from `(worldId, purpose, sourceId)` —
 * UUIDv5 over the namespace above, with
 * `name = "${worldId}:${purpose}:${sourceId}"` (i.e.
 * `"${worldId}:${journalKey(purpose, sourceId)}"`). Calling this twice
 * with the same inputs always returns the same id, which is what makes
 * `enqueueOperation` idempotent: re-enqueuing the same logical operation
 * (e.g. retried from an outer transaction) resolves to the same row
 * instead of creating a new one.
 */
export function deriveOperationId(
  worldId: string,
  purpose: OperationPurpose,
  sourceId: string,
): string {
  const name = `${worldId}:${journalKey(purpose, sourceId)}`;
  return uuidV5(OPERATION_ID_NAMESPACE, name);
}
