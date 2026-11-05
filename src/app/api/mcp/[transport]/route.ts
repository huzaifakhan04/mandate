import { randomUUID } from "crypto";

import { createMcpHandler } from "mcp-handler";

import { registry } from "@/server/contracts/registry";
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
