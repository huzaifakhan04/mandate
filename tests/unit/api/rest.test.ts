import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRestHandler } from "@/app/api/v1/[tool]/route";
import { ok } from "@/server/contracts/envelope";
import { registry } from "@/server/contracts/registry";
import "@/server/contracts/tools";
import { createTestDb } from "@/server/db/testing";

function params(tool: string) {
  return { params: Promise.resolve({ tool }) };
}

describe("REST contract route /api/v1/[tool]", () => {
  it("GET get_bank_guide returns 200 with status OK and bank: Mandate", async () => {
    const { GET } = createRestHandler({ getDb: createTestDb });
    const req = new Request("http://localhost/api/v1/get_bank_guide");

    const res = await GET(req, params("get_bank_guide"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("OK");
    expect(body.data.bank).toBe("Mandate");
  });

  it("POST get_bank_guide also works", async () => {
    const { POST } = createRestHandler({ getDb: createTestDb });
    const req = new Request("http://localhost/api/v1/get_bank_guide", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req, params("get_bank_guide"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("OK");
    expect(body.data.bank).toBe("Mandate");
  });

  it("POST /api/v1/nope returns 404 NOT_FOUND", async () => {
    const { POST } = createRestHandler({ getDb: createTestDb });
    const req = new Request("http://localhost/api/v1/nope", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req, params("nope"));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.status).toBe("NOT_FOUND");
  });

  it("GET /api/v1/nope also returns 404 NOT_FOUND", async () => {
    const { GET } = createRestHandler({ getDb: createTestDb });
    const req = new Request("http://localhost/api/v1/nope");

    const res = await GET(req, params("nope"));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.status).toBe("NOT_FOUND");
  });

  it("invalid JSON body returns 400 INVALID_REQUEST", async () => {
    const { POST } = createRestHandler({ getDb: createTestDb });
    const req = new Request("http://localhost/api/v1/get_bank_guide", {
      method: "POST",
      body: "{not valid json",
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req, params("get_bank_guide"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe("INVALID_REQUEST");
  });

  it("input that fails zod validation returns 400 INVALID_REQUEST with reason_codes", async () => {
    const { POST } = createRestHandler({ getDb: createTestDb });
    // get_bank_guide's input schema is z.object({}); an extra field of the
    // wrong shape elsewhere would fail — here we simulate a tool receiving
    // a non-object body, which fails validation against any z.object().
    const req = new Request("http://localhost/api/v1/get_bank_guide", {
      method: "POST",
      body: "42",
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req, params("get_bank_guide"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe("INVALID_REQUEST");
    expect(Array.isArray(body.reason_codes)).toBe(true);
    expect(body.reason_codes.length).toBeGreaterThan(0);
  });

  it("unexpected error (getDb throws) returns 500 INTERNAL_ERROR with no stack/message leak", async () => {
    const boom = new Error("connection string had password=super-secret");
    const { POST } = createRestHandler({
      getDb: async () => {
        throw boom;
      },
    });
    const req = new Request("http://localhost/api/v1/get_bank_guide", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req, params("get_bank_guide"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.status).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("super-secret");
    consoleErrorSpy.mockRestore();
  });

  describe("GET on a tool that does not support GET", () => {
    const otherTool = {
      name: "other_tool",
      title: "Other Tool",
      description: "A test-only POST-only tool used to exercise the 405 path for GET requests.",
      auth: "none" as const,
      mutating: false,
      input: z.object({}),
      output: z.object({}),
      handler: async () => ok({}, { status: "OK", summary: "ok" }),
    };

    afterEach(() => {
      const index = registry.indexOf(otherTool);
      if (index !== -1) {
        registry.splice(index, 1);
      }
    });

    it("returns 405 METHOD_NOT_ALLOWED", async () => {
      registry.push(otherTool);
      const { GET } = createRestHandler({ getDb: createTestDb });
      const req = new Request("http://localhost/api/v1/other_tool");

      const res = await GET(req, params("other_tool"));

      expect(res.status).toBe(405);
      const body = await res.json();
      expect(body.status).toBe("METHOD_NOT_ALLOWED");
    });
  });
});
