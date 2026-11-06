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
      readOnly: false,
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

describe("M2: GET parses query params into the tool's input", () => {
  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  async function registeredAgent() {
    process.env.API_KEY_PEPPER = "test-pepper";
    const db = await createTestDb();
    const handler = createRestHandler({ getDb: async () => db });
    const res = await handler.POST(
      new Request("http://localhost/api/v1/register_agent", {
        method: "POST",
        body: JSON.stringify({ name: "Getter", payout_email: "getter@example.com" }),
      }),
      params("register_agent"),
    );
    const body = await res.json();
    return { handler, key: body.data.api_key as string };
  }

  function get(url: string, key: string) {
    return new Request(url, { headers: { authorization: `Bearer ${key}` } });
  }

  it("get_loan?loan_id=… reaches the handler (NOT_FOUND for someone else's/unknown loan)", async () => {
    const { handler, key } = await registeredAgent();
    const res = await handler.GET(
      get("http://localhost/api/v1/get_loan?loan_id=0b0b1a8e-6f8e-4a0e-9d55-6a4f2d1c9e01", key),
      params("get_loan"),
    );
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.status).toBe("NOT_FOUND");
    expect(body.reason_codes).toContain("loan_not_found");
  });

  it("get_loan without loan_id → INVALID_REQUEST naming the field", async () => {
    const { handler, key } = await registeredAgent();
    const res = await handler.GET(get("http://localhost/api/v1/get_loan", key), params("get_loan"));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.reason_codes).toContain("loan_id");
  });

  it("check_eligibility?amount_cents=1000&term_days=7 converts digit strings for number fields", async () => {
    const { handler, key } = await registeredAgent();
    const res = await handler.GET(
      get("http://localhost/api/v1/check_eligibility?amount_cents=1000&term_days=7", key),
      params("check_eligibility"),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.quote.fee_cents).toBe(15);
  });

  it("does not coerce non-integer strings (the schema still rejects them)", async () => {
    const { handler, key } = await registeredAgent();
    const res = await handler.GET(
      get("http://localhost/api/v1/check_eligibility?amount_cents=1e3&term_days=7", key),
      params("check_eligibility"),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.reason_codes).toContain("amount_cents");
  });
});

describe("queryParamsToInput", () => {
  it("converts only integer strings for number-typed fields (through optional/default wrappers)", async () => {
    const { queryParamsToInput } = await import("@/server/contracts/queryInput");
    const schema = z.object({
      n: z.number().int(),
      maybe: z.number().optional(),
      withDefault: z.number().default(3),
      s: z.string(),
    });
    const input = queryParamsToInput(
      schema,
      new URLSearchParams("n=12&maybe=-4&withDefault=7&s=42&other=9&n2=x"),
    );
    expect(input).toEqual({ n: 12, maybe: -4, withDefault: 7, s: "42", other: "9", n2: "x" });
    expect(queryParamsToInput(schema, new URLSearchParams("n=1.5"))).toEqual({ n: "1.5" });
  });
});
