import { expect, test } from "@playwright/test";

const MCP_URL = "/api/mcp/mcp";
const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

/**
 * Both protocol generations the server supports can answer with either a
 * plain JSON body or a single-event `text/event-stream` body. Normalize to
 * the parsed JSON-RPC payload either way.
 */
interface Envelope {
  status: string;
  summary: string;
  reason_codes: string[];
  data: unknown;
  next_actions: unknown[];
  docs_url: string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    serverInfo?: { name: string; version: string };
    tools?: { name: string; inputSchema?: unknown }[];
    content?: { type: string; text: string }[];
    structuredContent?: Envelope;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

async function readJsonRpc(res: import("@playwright/test").APIResponse): Promise<JsonRpcResponse> {
  const contentType = res.headers()["content-type"] ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const dataLine = text
      .split("\n")
      .find((line) => line.startsWith("data:"));
    if (!dataLine) {
      throw new Error(`No SSE data line in response: ${text}`);
    }
    return JSON.parse(dataLine.slice("data:".length).trim()) as JsonRpcResponse;
  }
  return (await res.json()) as JsonRpcResponse;
}

test("MCP mandate-bank server exposes get_bank_guide over /api/mcp/mcp", async ({ request }) => {
  const initRes = await request.post(MCP_URL, {
    headers: MCP_HEADERS,
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mandate-e2e", version: "1.0.0" },
      },
    },
  });
  expect(initRes.ok()).toBeTruthy();
  const initBody = await readJsonRpc(initRes);
  expect(initBody.result?.serverInfo?.name).toBe("mandate-bank");

  const listRes = await request.post(MCP_URL, {
    headers: MCP_HEADERS,
    data: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  });
  expect(listRes.ok()).toBeTruthy();
  const listBody = await readJsonRpc(listRes);
  const tools = listBody.result?.tools ?? [];
  const names: string[] = tools.map((tool) => tool.name);
  expect(names).toContain("get_bank_guide");
  // tools/list still advertises the tool's real JSON schema, not a
  // permissive passthrough stand-in used only for dispatch.
  const guideTool = tools.find((tool) => tool.name === "get_bank_guide");
  expect(guideTool?.inputSchema).toBeTruthy();
  expect((guideTool?.inputSchema as { type?: string })?.type).toBe("object");

  const callRes = await request.post(MCP_URL, {
    headers: MCP_HEADERS,
    data: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_bank_guide", arguments: {} },
    },
  });
  expect(callRes.ok()).toBeTruthy();
  const callBody = await readJsonRpc(callRes);
  const text = callBody.result?.content?.[0]?.text ?? "";
  expect(text).toContain('"bank":"Mandate"');
  expect(callBody.result?.structuredContent?.status).toBe("OK");
  expect(callBody.result?.isError).toBe(false);
});

test("tools/call on an unknown tool returns runTool's NOT_FOUND envelope as a tool result, not a JSON-RPC error", async ({
  request,
}) => {
  const res = await request.post(MCP_URL, {
    headers: MCP_HEADERS,
    data: {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "no_such_tool", arguments: {} },
    },
  });

  // The MCP endpoint itself never 500s for a bad JSON-RPC request, and an
  // unknown tool name is not a JSON-RPC-level InvalidParams error either:
  // it is a normal tool result (`result.isError: true`) carrying the same
  // envelope shape `runTool`/the REST route returns for a 404.
  expect(res.status()).toBe(200);
  const body = await readJsonRpc(res);
  const raw = JSON.stringify(body);

  expect(body.error).toBeUndefined();
  expect(body.result?.isError).toBe(true);
  expect(body.result?.structuredContent?.status).toBe("NOT_FOUND");
  expect(body.result?.structuredContent?.reason_codes.length).toBeGreaterThan(0);
  expect(body.result?.structuredContent?.docs_url).toBeTruthy();
  expect(raw).not.toMatch(/at \S+ \(.*:\d+:\d+\)/); // no stack-trace frames leaked
});

test("tools/call with invalid args returns runTool's INVALID_REQUEST envelope with reason codes", async ({
  request,
}) => {
  const res = await request.post(MCP_URL, {
    headers: MCP_HEADERS,
    data: {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      // get_bank_guide's input schema is a strict empty object, so a
      // structurally valid JSON object with an unexpected key is a genuine
      // schema-validation failure that reaches `runTool` (unlike a
      // non-object `arguments` value, which the MCP protocol envelope
      // itself rejects before any tool-level dispatch).
      params: { name: "get_bank_guide", arguments: { unexpected_field: 1 } },
    },
  });

  expect(res.status()).toBe(200);
  const body = await readJsonRpc(res);
  const raw = JSON.stringify(body);

  expect(body.error).toBeUndefined();
  expect(body.result?.isError).toBe(true);
  expect(body.result?.structuredContent?.status).toBe("INVALID_REQUEST");
  expect(body.result?.structuredContent?.reason_codes.length).toBeGreaterThan(0);
  expect(raw).not.toMatch(/at \S+ \(.*:\d+:\d+\)/);
});

async function mcpCall(
  request: import("@playwright/test").APIRequestContext,
  id: number,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Envelope> {
  const res = await request.post(MCP_URL, {
    headers: { ...MCP_HEADERS, ...headers },
    data: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
  });
  expect(res.status()).toBe(200);
  const body = await readJsonRpc(res);
  return body.result!.structuredContent!;
}

test("M1: MCP tools/call honours the Idempotency-Key header (replay + header/argument mismatch)", async ({
  request,
}) => {
  const registered = await mcpCall(request, 30, "register_agent", {
    name: "Idem E2E",
    payout_email: "idem-e2e@example.com",
  });
  expect(registered.status).toBe("OK");
  const apiKey = (registered.data as { api_key: string }).api_key;
  const auth = { authorization: `Bearer ${apiKey}` };
  const apply = { amount_cents: 1000, term_days: 7, purpose: "E2E idempotency check" };

  const first = await mcpCall(request, 31, "apply_for_loan", apply, { ...auth, "Idempotency-Key": "e2e-idem-1" });
  const replay = await mcpCall(request, 32, "apply_for_loan", apply, { ...auth, "Idempotency-Key": "e2e-idem-1" });
  expect(first.status).not.toBe("INTERNAL_ERROR");
  expect(replay).toEqual(first);

  const mismatch = await mcpCall(
    request,
    33,
    "apply_for_loan",
    { ...apply, idempotency_key: "something-else" },
    { ...auth, "Idempotency-Key": "e2e-idem-2" },
  );
  expect(mismatch.status).toBe("INVALID_REQUEST");
  expect(mismatch.reason_codes).toContain("idempotency_key_mismatch");
});

test("P2 Task 3: MCP signatures cover the raw JSON-RPC body; after register_public_key unsigned mutating calls are rejected", async ({
  request,
}) => {
  const { createHash, generateKeyPairSync, sign } = await import("crypto");
  const registered = await mcpCall(request, 40, "register_agent", { name: "Signer E2E", payout_email: "signer-e2e@example.com" });
  const apiKey = (registered.data as { api_key: string }).api_key;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");

  async function rawCall(id: number, name: string, args: Record<string, unknown>, signIt: boolean): Promise<Envelope> {
    const body = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const headers: Record<string, string> = { ...MCP_HEADERS, authorization: `Bearer ${apiKey}` };
    if (signIt) {
      const ts = String(Math.floor(Date.now() / 1000));
      const digest = createHash("sha256").update(body).digest("hex");
      headers["x-mandate-timestamp"] = ts;
      headers["x-mandate-signature"] = sign(null, Buffer.from(`${ts}\nPOST\n/api/mcp/mcp\n${digest}`), privateKey).toString("base64");
    }
    const res = await request.post(MCP_URL, { headers, data: body });
    expect(res.status()).toBe(200);
    return (await readJsonRpc(res)).result!.structuredContent!;
  }

  const registeredKey = await rawCall(41, "register_public_key", { public_key: spki }, true);
  expect(registeredKey.status).toBe("OK");

  const unsigned = await rawCall(42, "redeem_notes", { amount_cents: 1000 }, false);
  expect(unsigned.status).toBe("SIGNATURE_REQUIRED");

  const signed = await rawCall(43, "redeem_notes", { amount_cents: 1000 }, true);
  expect(signed.status).not.toMatch(/^SIGNATURE_/);
});
