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
  result: {
    serverInfo?: { name: string; version: string };
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
  };
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
  expect(initBody.result.serverInfo?.name).toBe("mandate-bank");

  const listRes = await request.post(MCP_URL, {
    headers: MCP_HEADERS,
    data: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  });
  expect(listRes.ok()).toBeTruthy();
  const listBody = await readJsonRpc(listRes);
  const names: string[] = (listBody.result.tools ?? []).map((tool) => tool.name);
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
  const text = callBody.result.content?.[0]?.text ?? "";
  expect(text).toContain('"bank":"Mandate"');
});
