import { randomUUID } from "crypto";

import { getSimNow } from "../clock/clock";
import type { Db } from "../db/client";
import { ensureMainWorld } from "../services/worlds";
import type { Envelope } from "./envelope";
import { fail } from "./envelope";
import type { ToolDef } from "./registry";

export interface RunToolDeps {
  getDb: () => Promise<Db>;
  agentId?: string | null;
  requestId?: string;
}

export interface RunToolResult {
  httpStatus: number;
  envelope: Envelope<unknown>;
}

/**
 * The single dispatch path shared by REST and MCP: validate `rawInput`
 * against the tool's input schema, build the per-request `ToolCtx`
 * (world/clock from Task 4, `agentId`/`requestId`), and run the handler.
 *
 * Every failure mode — unknown tool, invalid input, or any thrown error
 * from `getDb`/`ensureMainWorld`/`getSimNow`/the handler itself — comes
 * back as an envelope plus an HTTP-style status, never a thrown error or a
 * leaked stack trace/raw message. Unexpected errors are logged server-side
 * (with `requestId`) before being turned into a generic `INTERNAL_ERROR`
 * envelope that carries the same `requestId` for correlation.
 */
export async function runTool(
  tool: ToolDef | undefined,
  toolName: string,
  rawInput: unknown,
  { getDb, agentId = null, requestId = randomUUID() }: RunToolDeps,
): Promise<RunToolResult> {
  if (!tool) {
    return {
      httpStatus: 404,
      envelope: fail("NOT_FOUND", `Unknown tool: ${toolName}`, [toolName]),
    };
  }

  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    const reasonCodes = parsed.error.issues.map((issue) => issue.path.join(".") || "root");
    return {
      httpStatus: 400,
      envelope: fail("INVALID_REQUEST", "Invalid input.", reasonCodes),
    };
  }

  try {
    const db = await getDb();
    const { worldId } = await ensureMainWorld(db);
    const simNow = await getSimNow(db, worldId);

    const envelope = await tool.handler(parsed.data, {
      worldId,
      simNow,
      agentId,
      requestId,
    });

    return { httpStatus: 200, envelope };
  } catch (err) {
    // The real error (which may include infra details, e.g. connection
    // strings or query text) is logged server-side only, keyed by
    // requestId. Callers/clients only ever see the generic message below.
    console.error(`[runTool] ${toolName} failed (requestId=${requestId}):`, err);

    return {
      httpStatus: 500,
      envelope: fail(
        "INTERNAL_ERROR",
        `Something went wrong handling this request. (request_id: ${requestId})`,
        ["internal_error"],
        { request_id: requestId },
      ),
    };
  }
}
