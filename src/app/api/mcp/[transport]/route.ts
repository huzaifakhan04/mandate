import { randomUUID } from "crypto";

import { createMcpHandler } from "mcp-handler";

import { getSimNow } from "@/server/clock/clock";
import { registry } from "@/server/contracts/registry";
import "@/server/contracts/tools";
import { getDb } from "@/server/db/client";
import { ensureMainWorld } from "@/server/services/worlds";

/**
 * One MCP tool per registry entry. The handler reuses the same per-request
 * context (worldId/simNow/agentId/requestId) as the REST route, and returns
 * the tool's envelope both as `content[0].text` (JSON string) and as
 * `structuredContent`, so clients can read either.
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
          const db = await getDb();
          const { worldId } = await ensureMainWorld(db);
          const simNow = await getSimNow(db, worldId);

          const envelope = await tool.handler(input, {
            worldId,
            simNow,
            agentId: null,
            requestId: randomUUID(),
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
            structuredContent: envelope,
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
