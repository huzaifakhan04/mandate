import { createHash } from "crypto";

import { and, desc, eq } from "drizzle-orm";

import { isUuid, ownedAgent } from "../auth/ownership";
import type { Db } from "../db/client";
import { kyaDocuments } from "../db/schema";
import { scoped } from "../db/scoped";

/**
 * KYA documents (P2 Task 3, Ruling P2-A): an owner uploads a pdf/png/jpg
 * (≤ 2 MB) for an agent they claimed; the bytes live in Postgres
 * (`kya_documents.content`, bytea). Review in P2 is automatic: a file
 * that passes the type (magic bytes) and size checks is `approved`. P3
 * adds an LLM review.
 */

export const MAX_KYA_DOCUMENT_BYTES = 2 * 1024 * 1024;

export const KYA_DOCUMENT_KINDS = ["operator_registration", "code_manifest", "other"] as const;
export type KyaDocumentKind = (typeof KYA_DOCUMENT_KINDS)[number];

export type KyaDocumentType = "application/pdf" | "image/png" | "image/jpeg";

export { isUuid };

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, i) => bytes[i] === byte);
}

/** The file's type from its leading magic bytes — never from a declared content type. */
export function detectDocumentType(bytes: Uint8Array): KyaDocumentType | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "application/pdf"; // "%PDF-"
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  return null;
}

/** A display-safe file name: no path, no control characters, ≤ 120 chars. */
function sanitizeFileName(name: string | null | undefined): string {
  const base = (name ?? "").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (base || "document").slice(0, 120);
}

/** A document's metadata (never its bytes). */
export interface KyaDocumentSummary {
  id: string;
  worldId: string;
  agentId: string;
  kind: string;
  fileName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  sha256: string;
  reviewStatus: string;
  createdAt: Date;
}

type KyaDocumentRow = typeof kyaDocuments.$inferSelect;

function summarize(row: KyaDocumentRow): KyaDocumentSummary {
  return {
    id: row.id,
    worldId: row.worldId,
    agentId: row.agentId,
    kind: row.kind,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    reviewStatus: row.reviewStatus,
    createdAt: row.createdAt,
  };
}

export interface UploadKyaDocumentInput {
  principalId: string;
  agentId: string;
  kind: string;
  fileName: string | null;
  bytes: Uint8Array;
}

export type UploadKyaDocumentResult =
  | { outcome: "agent_not_found" }
  | { outcome: "invalid_kind" }
  | { outcome: "empty" }
  | { outcome: "too_large" }
  | { outcome: "unsupported_type" }
  | { outcome: "uploaded"; document: KyaDocumentSummary };

export async function uploadKyaDocument(db: Db, input: UploadKyaDocumentInput): Promise<UploadKyaDocumentResult> {
  const agent = await ownedAgent(db, input.principalId, input.agentId);
  if (!agent) {
    return { outcome: "agent_not_found" };
  }
  if (!(KYA_DOCUMENT_KINDS as readonly string[]).includes(input.kind)) {
    return { outcome: "invalid_kind" };
  }
  if (input.bytes.length === 0) {
    return { outcome: "empty" };
  }
  if (input.bytes.length > MAX_KYA_DOCUMENT_BYTES) {
    return { outcome: "too_large" };
  }
  const contentType = detectDocumentType(input.bytes);
  if (!contentType) {
    return { outcome: "unsupported_type" };
  }

  const content = Buffer.from(input.bytes);
  const now = new Date();
  // P2 auto-review: the checks above are the whole review.
  const [row] = await scoped(db, agent.worldId).insert(kyaDocuments, {
    agentId: agent.id,
    principalId: input.principalId,
    kind: input.kind,
    fileName: sanitizeFileName(input.fileName),
    content,
    contentType,
    sizeBytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    reviewStatus: "approved",
    aiReview: {
      reviewer: "auto_p2",
      checks: { magic_bytes_type: contentType, size_bytes: content.length, max_bytes: MAX_KYA_DOCUMENT_BYTES },
      decision: "approved",
      decided_at: now.toISOString(),
    },
  });
  if (!row) {
    throw new Error("Expected a kya_documents row to be inserted");
  }
  return { outcome: "uploaded", document: summarize(row) };
}

/** The owner's documents for `agentId`, newest first; `null` if they don't own it. */
export async function listKyaDocuments(db: Db, principalId: string, agentId: string): Promise<KyaDocumentSummary[] | null> {
  const agent = await ownedAgent(db, principalId, agentId);
  if (!agent) {
    return null;
  }
  return scoped(db, agent.worldId).selectFields(
    kyaDocuments,
    {
      id: kyaDocuments.id,
      worldId: kyaDocuments.worldId,
      agentId: kyaDocuments.agentId,
      kind: kyaDocuments.kind,
      fileName: kyaDocuments.fileName,
      contentType: kyaDocuments.contentType,
      sizeBytes: kyaDocuments.sizeBytes,
      sha256: kyaDocuments.sha256,
      reviewStatus: kyaDocuments.reviewStatus,
      createdAt: kyaDocuments.createdAt,
    },
    and(eq(kyaDocuments.agentId, agent.id), eq(kyaDocuments.principalId, principalId)),
    desc(kyaDocuments.createdAt),
  );
}

/** Deletes one of the owner's documents for `agentId`. */
export async function deleteKyaDocument(
  db: Db,
  principalId: string,
  agentId: string,
  documentId: string,
): Promise<"deleted" | "not_found"> {
  const agent = await ownedAgent(db, principalId, agentId);
  if (!agent || !isUuid(documentId)) {
    return "not_found";
  }
  const deleted = await scoped(db, agent.worldId).delete(
    kyaDocuments,
    and(eq(kyaDocuments.id, documentId), eq(kyaDocuments.agentId, agent.id), eq(kyaDocuments.principalId, principalId))!,
  );
  return deleted.length > 0 ? "deleted" : "not_found";
}
