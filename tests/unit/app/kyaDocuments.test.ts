/**
 * P2 Task 3: owner KYA document uploads (Ruling P2-A: Postgres bytea,
 * ≤ 2 MB). Session + ownership + same-origin; the type comes from magic
 * bytes, not the declared content type. Review Focus 3: another
 * principal's agent → 404.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDocumentHandlers } from "@/server/auth/documentRoutes";
import { SESSION_COOKIE_NAME, createSession } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { agents, kyaDocuments, principals } from "@/server/db/schema";
import { createTestDb } from "@/server/db/testing";
import { MAX_KYA_DOCUMENT_BYTES, detectDocumentType } from "@/server/services/kyaDocs";

import { createSimWorld, createTestAgent } from "../../helpers/world";

const ORIGIN = "https://mandate.test";
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(100, 0x20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);

interface Doc {
  id: string;
  kind: string;
  review_status: string;
  content_type: string;
  size_bytes: number;
  file_name: string;
}

describe("detectDocumentType", () => {
  it("recognises pdf, png and jpg by magic bytes only", () => {
    expect(detectDocumentType(PDF)).toBe("application/pdf");
    expect(detectDocumentType(PNG)).toBe("image/png");
    expect(detectDocumentType(JPG)).toBe("image/jpeg");
    expect(detectDocumentType(Buffer.from("<html>%PDF-"))).toBeNull();
    expect(detectDocumentType(Buffer.alloc(0))).toBeNull();
  });
});

describe("/dashboard/agents/[id]/documents", () => {
  let db: Db;
  let handlers: ReturnType<typeof createDocumentHandlers>;
  let agentId: string;
  let ownerId: string;
  let otherId: string;

  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
    vi.stubEnv("API_KEY_PEPPER", "test-pepper");
    vi.stubEnv("PUBLIC_BASE_URL", ORIGIN);
    db = await createTestDb();
    handlers = createDocumentHandlers({ getDb: async () => db });
    const worldId = await createSimWorld(db);
    agentId = (await createTestAgent(db, worldId)).agentId;
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    ownerId = agent!.principalId!;
    const [other] = await db
      .insert(principals)
      .values({ paypalPayerId: "OTHER", email: "o@example.com", name: "Other", entityType: "individual", verifiedAt: new Date() })
      .returning();
    otherId = other!.id;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function headers(principalId: string | null, origin = ORIGIN): Record<string, string> {
    const h: Record<string, string> = { origin, accept: "application/json" };
    if (principalId) {
      h.cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSession(principalId))}`;
    }
    return h;
  }

  function upload(
    bytes: Buffer,
    options: { principalId?: string | null; origin?: string; kind?: string; type?: string; name?: string; id?: string } = {},
  ) {
    const form = new FormData();
    form.set("kind", options.kind ?? "operator_registration");
    form.set("file", new File([new Uint8Array(bytes)], options.name ?? "doc.pdf", { type: options.type ?? "application/pdf" }));
    const id = options.id ?? agentId;
    return handlers.upload(
      new Request(`${ORIGIN}/dashboard/agents/${id}/documents`, {
        method: "POST",
        body: form,
        headers: headers(options.principalId === undefined ? ownerId : options.principalId, options.origin),
      }),
      id,
    );
  }

  it("the owner uploads a pdf; it is auto-approved and stored inline", async () => {
    const res = await upload(PDF);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { document: Doc };
    expect(body.document).toMatchObject({
      kind: "operator_registration",
      review_status: "approved",
      content_type: "application/pdf",
      size_bytes: PDF.length,
      file_name: "doc.pdf",
    });
    const [row] = await db.select().from(kyaDocuments);
    expect(Buffer.compare(row!.content!, PDF)).toBe(0);
    expect(row!.principalId).toBe(ownerId);
  });

  it("png and jpg are accepted; the declared content type is ignored in favour of magic bytes", async () => {
    expect((await upload(PNG, { type: "application/pdf", name: "a.png" })).status).toBe(201);
    expect((await upload(JPG, { type: "image/png", name: "a.jpg", kind: "code_manifest" })).status).toBe(201);
    const rows = await db.select().from(kyaDocuments);
    expect(rows.map((r) => r.contentType).sort()).toEqual(["image/jpeg", "image/png"]);
  });

  it("a file whose bytes are not pdf/png/jpg → 415, even if declared application/pdf", async () => {
    const res = await upload(Buffer.from("<script>alert(1)</script>"), { type: "application/pdf" });
    expect(res.status).toBe(415);
    expect(await db.select().from(kyaDocuments)).toHaveLength(0);
  });

  it("a file over 2 MB → 413", async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_KYA_DOCUMENT_BYTES)]);
    const res = await upload(big);
    expect(res.status).toBe(413);
    expect(await db.select().from(kyaDocuments)).toHaveLength(0);
  });

  it("an unknown kind or an empty file → 400", async () => {
    expect((await upload(PDF, { kind: "passport" })).status).toBe(400);
    expect((await upload(Buffer.alloc(0))).status).toBe(400);
  });

  it("no session → 401; cross-origin → 403", async () => {
    expect((await upload(PDF, { principalId: null })).status).toBe(401);
    expect((await upload(PDF, { origin: "https://evil.example" })).status).toBe(403);
    expect(await db.select().from(kyaDocuments)).toHaveLength(0);
  });

  it("another principal's agent, or an unknown/malformed id → 404", async () => {
    expect((await upload(PDF, { principalId: otherId })).status).toBe(404);
    expect((await upload(PDF, { id: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await upload(PDF, { id: "not-a-uuid" })).status).toBe(404);
    expect(await db.select().from(kyaDocuments)).toHaveLength(0);
  });

  it("lists (metadata only) and deletes the owner's documents; never another principal's", async () => {
    await upload(PDF);
    const list = (principalId: string) =>
      handlers.list(new Request(`${ORIGIN}/dashboard/agents/${agentId}/documents`, { headers: headers(principalId) }), agentId);

    const listed = await list(ownerId);
    expect(listed.status).toBe(200);
    const { documents } = (await listed.json()) as { documents: Doc[] };
    expect(documents).toHaveLength(1);
    expect(documents[0]).not.toHaveProperty("content");
    expect((await list(otherId)).status).toBe(404);

    const del = (principalId: string, docId: string, origin = ORIGIN) =>
      handlers.remove(
        new Request(`${ORIGIN}/dashboard/agents/${agentId}/documents/${docId}`, { method: "DELETE", headers: headers(principalId, origin) }),
        agentId,
        docId,
      );
    const docId = documents[0]!.id;
    expect((await del(otherId, docId)).status).toBe(404);
    expect((await del(ownerId, docId, "https://evil.example")).status).toBe(403);
    expect(await db.select().from(kyaDocuments)).toHaveLength(1);
    expect((await del(ownerId, docId)).status).toBe(200);
    expect(await db.select().from(kyaDocuments)).toHaveLength(0);
    expect((await del(ownerId, docId)).status).toBe(404);
  });

  it("a browser form post (Accept: text/html) is redirected back to the agent page", async () => {
    const form = new FormData();
    form.set("kind", "other");
    form.set("file", new File([new Uint8Array(PDF)], "x.pdf"));
    const res = await handlers.upload(
      new Request(`${ORIGIN}/dashboard/agents/${agentId}/documents`, {
        method: "POST",
        body: form,
        headers: { ...headers(ownerId), accept: "text/html" },
      }),
      agentId,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/dashboard?agent=${agentId}&document=uploaded#agent-drawer`);
  });
});
