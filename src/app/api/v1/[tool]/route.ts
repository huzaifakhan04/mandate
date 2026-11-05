import { randomUUID } from "crypto";

import { NextResponse } from "next/server";

import { fail } from "@/server/contracts/envelope";
import { findTool } from "@/server/contracts/registry";
import { runTool } from "@/server/contracts/runTool";
import "@/server/contracts/tools";
import { getDb as defaultGetDb, type Db } from "@/server/db/client";

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
  async function dispatch(toolName: string, rawInput: unknown, requestId: string): Promise<NextResponse> {
    const tool = findTool(toolName);
    const { httpStatus, envelope } = await runTool(tool, toolName, rawInput, { getDb, requestId });
    return NextResponse.json(envelope, { status: httpStatus });
  }

  return {
    async GET(_req: Request, { params }: RouteParams): Promise<NextResponse> {
      const { tool } = await params;
      const requestId = randomUUID();

      const found = findTool(tool);
      if (!found) {
        return NextResponse.json(fail("NOT_FOUND", `Unknown tool: ${tool}`, [tool]), {
          status: 404,
        });
      }
      if (tool !== "get_bank_guide") {
        return NextResponse.json(
          fail("METHOD_NOT_ALLOWED", `GET is not supported for tool: ${tool}`, [tool]),
          { status: 405 },
        );
      }

      return dispatch(tool, {}, requestId);
    },

    async POST(req: Request, { params }: RouteParams): Promise<NextResponse> {
      const { tool } = await params;
      const requestId = randomUUID();

      let rawInput: unknown;
      try {
        rawInput = await readJsonBody(req);
      } catch {
        return NextResponse.json(
          fail("INVALID_REQUEST", "Request body must be valid JSON.", ["body"]),
          { status: 400 },
        );
      }

      return dispatch(tool, rawInput, requestId);
    },
  };
}

const { GET, POST } = createRestHandler({ getDb: defaultGetDb });

export { GET, POST };
