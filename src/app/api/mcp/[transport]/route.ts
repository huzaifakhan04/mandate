import { randomUUID } from "crypto";

import { createMcpHandler } from "mcp-handler";

import { findTool, registry } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import "@/server/contracts/tools";
import { getDb } from "@/server/db/client";

/**
 * One MCP tool per registry entry. Dispatch goes through the same
 * `runTool` the REST route uses, so unknown-tool/invalid-input/unexpected
 * errors are handled identically: the envelope is always returned (never a
 * thrown error or leaked stack trace), as both `content[0].text` (JSON
 * string) and `structuredContent`, with `isError: true` whenever the
 * shared dispatch reports a non-2xx status.
 *
 * `registerTool` is still used so `tools/list` advertises each tool's real
 * JSON schema, title, and description. But the SDK's own per-tool
 * `tools/call` dispatch (the handler `registerTool` wires up internally)
 * validates `arguments` against `inputSchema` *before* invoking our
 * callback, and rejects an unknown tool name with a raw JSON-RPC
 * `InvalidParams` error — both happen upstream of `runTool`, so its
 * envelope (with `reason_codes`/`next_actions`/`docs_url`) never reaches
 * the client for those cases (Review Focus 4). To fix that, once every
 * tool is registered we override the low-level `tools/call` request
 * handler so *every* call — known tool, unknown tool, valid args, invalid
 * args — goes through `runTool(findTool(name), name, args ?? {}, deps)`,
 * and that envelope is the only thing ever sent back over MCP.
 */
const mcpHandler = createMcpHandler(
  (server) => {
    for (const tool of registry) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.input,
        },
        // Unreachable in practice: the `tools/call` override installed
        // below intercepts every call before the SDK's per-tool dispatch
        // (and its input validation) ever runs. Kept as a safe fallback.
        async (input) => {
          const requestId = randomUUID();
          const { httpStatus, envelope } = await runTool(tool, tool.name, input, {
            getDb,
            requestId,
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
            structuredContent: envelope,
            isError: httpStatus >= 400,
          };
        },
      );
    }

    // Override the SDK's built-in `tools/call` handler (installed as a
    // side effect of the `registerTool` calls above) so no per-tool schema
    // validation or tool-name lookup happens before `runTool` runs. This is
    // the only code path that ever handles `tools/call` for this server.
    server.server.setRequestHandler("tools/call", async (request) => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      const requestId = randomUUID();
      const { httpStatus, envelope } = await runTool(findTool(name), name, args, {
        getDb,
        requestId,
      });

      const result = {
        content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
        structuredContent: envelope,
        isError: httpStatus >= 400,
      };

      // Project through the negotiated wire codec, same as the SDK's own
      // `tools/call` handler, so clients on either protocol era see the
      // same result shape they would from a normal `registerTool` callback.
      return server.server.projectCallToolResult(result, undefined);
    });
  },
  { serverInfo: { name: "mandate-bank", version: "1.0.0" } },
);

type RouteParams = { params: Promise<{ transport: string }> };

async function dispatch(req: Request, { params }: RouteParams): Promise<Response> {
  const { transport } = await params;
  if (transport !== "mcp") {
    return new Response("Not Found", { status: 404 });
  }
  return mcpHandler(req);
}

export { dispatch as DELETE, dispatch as GET, dispatch as POST };
