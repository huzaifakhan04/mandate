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
