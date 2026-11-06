import type { Db } from "../db/client";
import {
  MAX_KYA_DOCUMENT_BYTES,
  deleteKyaDocument,
  isUuid,
  listKyaDocuments,
  uploadKyaDocument,
  type KyaDocumentSummary,
} from "../services/kyaDocs";
import { reviewKyaDocument } from "../services/kyaDesk";
import { agentDashboardPath } from "./dashboardPaths";
import { principalFromRequest, signInPath } from "./guard";
import { isSameOriginPost } from "./routes";

/**
 * Owner KYA document routes (P2 Task 3), built over `getDb` so tests
 * drive them with PGlite:
 *
 * - `GET  /dashboard/agents/<id>/documents` — the owner's documents (metadata only);
 * - `POST /dashboard/agents/<id>/documents` — multipart upload (`kind`, `file`):
 *   pdf/png/jpg by magic bytes, ≤ 2 MB, auto-approved;
 * - `DELETE` (or form `POST`) `/dashboard/agents/<id>/documents/<docId>`.
 *
 * Every route needs a session (401) and ownership of the agent — anyone
 * else's agent or document, or a malformed id, is 404 (Review Focus 3).
 * Writes are same-origin only (403). A browser form (`Accept: text/html`)
 * gets a 303 back to the agent page; anything else gets JSON.
 */

const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

type Kind = "uploaded" | "deleted";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

function seeOther(request: Request, path: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: new URL(path, request.url).toString(), "cache-control": "no-store" },
  });
}

function agentPage(agentId: string, query: Record<string, string> = {}): string {
  return agentDashboardPath(agentId, query);
}

/** An error, as JSON or (browser form) a redirect back to the agent page. */
function failure(request: Request, agentId: string, status: number, code: string, message: string): Response {
  if (wantsHtml(request)) {
    if (status === 401) {
      return seeOther(request, signInPath(`/dashboard?agent=${agentId}`));
    }
    if (status === 403 || status === 404) {
      return new Response(status === 403 ? "Forbidden" : "Not found", {
        status,
        headers: { "content-type": "text/plain", "cache-control": "no-store" },
      });
    }
    return seeOther(request, agentPage(agentId, { document_error: code }));
  }
  return json(status, { error: code, message });
}

function success(request: Request, agentId: string, status: number, kind: Kind, body: unknown): Response {
  return wantsHtml(request) ? seeOther(request, agentPage(agentId, { document: kind })) : json(status, body);
}

function toJson(doc: KyaDocumentSummary) {
  return {
    id: doc.id,
    agent_id: doc.agentId,
    kind: doc.kind,
    file_name: doc.fileName,
    content_type: doc.contentType,
    size_bytes: doc.sizeBytes,
    sha256: doc.sha256,
    review_status: doc.reviewStatus,
    created_at: doc.createdAt.toISOString(),
  };
}

const UPLOAD_FAILURES = {
  agent_not_found: [404, "Agent not found."],
  invalid_kind: [400, "kind must be operator_registration, code_manifest or other."],
  empty: [400, "The file is empty."],
  too_large: [413, "The file is larger than 2 MB."],
  unsupported_type: [415, "Only PDF, PNG and JPEG files are accepted."],
} as const;

export interface DocumentHandlerDeps {
  getDb: () => Promise<Db>;
  /**
   * P3 Task 4: schedules work to run after the response is sent — the app
   * route passes next/server `after()`; tests collect and run the tasks.
   * Omitted: nothing is scheduled.
   */
  afterResponse?: (task: () => Promise<unknown>) => void;
}

export function createDocumentHandlers({ getDb, afterResponse }: DocumentHandlerDeps) {
  async function list(request: Request, agentId: string): Promise<Response> {
    const session = principalFromRequest(request);
    if (!session) {
      return json(401, { error: "unauthorized", message: "Sign in with PayPal to continue." });
    }
    const documents = isUuid(agentId) ? await listKyaDocuments(await getDb(), session.principalId, agentId) : null;
    if (!documents) {
      return json(404, { error: "not_found", message: "Agent not found." });
    }
    return json(200, { documents: documents.map(toJson) });
  }

  async function upload(request: Request, agentId: string): Promise<Response> {
    if (!isUuid(agentId)) {
      return failure(request, agentId, 404, "not_found", "Agent not found.");
    }
    if (!isSameOriginPost(request)) {
      return failure(request, agentId, 403, "forbidden", "Forbidden.");
    }
    const session = principalFromRequest(request);
    if (!session) {
      return failure(request, agentId, 401, "unauthorized", "Sign in with PayPal to continue.");
    }
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_KYA_DOCUMENT_BYTES + MULTIPART_OVERHEAD_BYTES) {
      return failure(request, agentId, 413, "too_large", UPLOAD_FAILURES.too_large[1]);
    }

    let kind: FormDataEntryValue | null;
    let file: FormDataEntryValue | null;
    try {
      const form = await request.formData();
      kind = form.get("kind");
      file = form.get("file");
    } catch {
      return failure(request, agentId, 400, "invalid_form", "Send multipart/form-data with kind and file.");
    }
    if (typeof kind !== "string" || !file || typeof file === "string") {
      return failure(request, agentId, 400, "invalid_form", "Send multipart/form-data with kind and file.");
    }
    if (file.size > MAX_KYA_DOCUMENT_BYTES) {
      return failure(request, agentId, 413, "too_large", UPLOAD_FAILURES.too_large[1]);
    }

    try {
      const result = await uploadKyaDocument(await getDb(), {
        principalId: session.principalId,
        agentId,
        kind,
        fileName: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      if (result.outcome !== "uploaded") {
        const [status, message] = UPLOAD_FAILURES[result.outcome];
        return failure(request, agentId, status, result.outcome, message);
      }
      // The KYA desk (advisory LLM review) runs after the response; it never throws.
      const { worldId, id: documentId } = result.document;
      afterResponse?.(() => reviewKyaDocument(getDb, worldId, documentId));
      return success(request, agentId, 201, "uploaded", { document: toJson(result.document) });
    } catch (err) {
      console.error(`[kya-documents] upload failed: ${err instanceof Error ? err.name : "unknown error"}`);
      return failure(request, agentId, 500, "error", "Something went wrong saving this document.");
    }
  }

  async function remove(request: Request, agentId: string, documentId: string): Promise<Response> {
    if (!isUuid(agentId) || !isUuid(documentId)) {
      return failure(request, agentId, 404, "not_found", "Document not found.");
    }
    if (!isSameOriginPost(request)) {
      return failure(request, agentId, 403, "forbidden", "Forbidden.");
    }
    const session = principalFromRequest(request);
    if (!session) {
      return failure(request, agentId, 401, "unauthorized", "Sign in with PayPal to continue.");
    }
    const outcome = await deleteKyaDocument(await getDb(), session.principalId, agentId, documentId);
    if (outcome === "not_found") {
      return failure(request, agentId, 404, "not_found", "Document not found.");
    }
    return success(request, agentId, 200, "deleted", { deleted: documentId });
  }

  return { list, upload, remove };
}
