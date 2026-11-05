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
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    serverInfo?: { name: string; version: string };
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
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
  const names: string[] = (listBody.result?.tools ?? []).map((tool) => tool.name);
  expect(names).toContain("get_bank_guide");

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
});

test("tools/call on an unknown tool returns a sensible MCP error, not a 500/stack trace", async ({
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

  // The MCP endpoint itself never 500s for a bad JSON-RPC request — the
  // failure is reported inside the JSON-RPC envelope (an `error` member,
  // or `result.isError`), with HTTP 200.
  expect(res.status()).toBe(200);
  const body = await readJsonRpc(res);
  const raw = JSON.stringify(body);

  const reportedAsError = body.error !== undefined || body.result?.isError === true;
  expect(reportedAsError).toBe(true);
  expect(raw).not.toMatch(/at \S+ \(.*:\d+:\d+\)/); // no stack-trace frames leaked
});

test("tools/call with invalid args returns a sensible MCP error, not a 500/stack trace", async ({
  request,
}) => {
  const res = await request.post(MCP_URL, {
    headers: MCP_HEADERS,
    data: {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      // get_bank_guide takes no arguments; a non-object `arguments` value
      // is invalid at the MCP protocol level, before our own tool schema
      // ever sees it.
      params: { name: "get_bank_guide", arguments: "not-an-object" },
    },
  });

  expect(res.status()).toBe(200);
  const body = await readJsonRpc(res);
  const raw = JSON.stringify(body);

  const reportedAsError = body.error !== undefined || body.result?.isError === true;
  expect(reportedAsError).toBe(true);
  expect(raw).not.toMatch(/at \S+ \(.*:\d+:\d+\)/);
});
