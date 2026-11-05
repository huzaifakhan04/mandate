import { randomUUID } from "crypto";

import { NextResponse } from "next/server";

import { getSimNow } from "@/server/clock/clock";
import { fail } from "@/server/contracts/envelope";
import { findTool } from "@/server/contracts/registry";
import "@/server/contracts/tools";
import { getDb as defaultGetDb, type Db } from "@/server/db/client";
import { ensureMainWorld } from "@/server/services/worlds";

type RouteParams = { params: Promise<{ tool: string }> };

export interface RestHandlerDeps {
  getDb: () => Promise<Db>;
}

/** Reads a request body as JSON, treating an empty body as `{}`. */
async function readJsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length === 0) {
    return {};
  }
  return JSON.parse(text);
}

/**
 * Builds the GET/POST handlers for `/api/v1/{tool}`, with the database
 * resolver injected so tests can pass a PGlite test db instead of the real
 * (lazy) Neon/dev resolver.
 */
export function createRestHandler({ getDb }: RestHandlerDeps) {
  async function handle(toolName: string, rawInputPromise: Promise<unknown>): Promise<NextResponse> {
    const tool = findTool(toolName);
    if (!tool) {
      return NextResponse.json(fail("NOT_FOUND", `Unknown tool: ${toolName}`, [toolName]), {
        status: 404,
      });
    }

    let rawInput: unknown;
    try {
      rawInput = await rawInputPromise;
    } catch {
      return NextResponse.json(
        fail("INVALID_REQUEST", "Request body must be valid JSON.", ["body"]),
        { status: 400 },
      );
    }

    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) {
      const reasonCodes = parsed.error.issues.map((issue) => issue.path.join(".") || "root");
      return NextResponse.json(
        fail("INVALID_REQUEST", "Invalid input.", reasonCodes),
        { status: 400 },
      );
    }

    const db = await getDb();
    const { worldId } = await ensureMainWorld(db);
    const simNow = await getSimNow(db, worldId);

    const envelope = await tool.handler(parsed.data, {
      worldId,
      simNow,
      agentId: null,
      requestId: randomUUID(),
    });

    return NextResponse.json(envelope, { status: 200 });
  }

  return {
    async GET(_req: Request, { params }: RouteParams): Promise<NextResponse> {
      const { tool } = await params;
      if (tool !== "get_bank_guide") {
        return NextResponse.json(
          fail("NOT_FOUND", `GET is not supported for tool: ${tool}`, [tool]),
          { status: 404 },
        );
      }
      return handle(tool, Promise.resolve({}));
    },

    async POST(req: Request, { params }: RouteParams): Promise<NextResponse> {
      const { tool } = await params;
      return handle(tool, readJsonBody(req));
    },
  };
}

const { GET, POST } = createRestHandler({ getDb: defaultGetDb });

export { GET, POST };
