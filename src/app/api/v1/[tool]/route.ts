import { randomUUID } from "crypto";

import { NextResponse } from "next/server";

import { fail } from "@/server/contracts/envelope";
import { queryParamsToInput } from "@/server/contracts/queryInput";
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
  async function dispatch(
    toolName: string,
    rawInput: unknown,
    requestId: string,
    req: Request,
  ): Promise<NextResponse> {
    const tool = findTool(toolName);
    const authorization = req.headers.get("authorization");
    const idempotencyKey = req.headers.get("idempotency-key");
    const { httpStatus, envelope } = await runTool(tool, toolName, rawInput, {
      getDb,
      requestId,
      authorization,
      idempotencyKey,
    });
    return NextResponse.json(envelope, { status: httpStatus });
  }

  return {
    async GET(req: Request, { params }: RouteParams): Promise<NextResponse> {
      const { tool } = await params;
      const requestId = randomUUID();

      const found = findTool(tool);
      if (!found) {
        return NextResponse.json(fail("NOT_FOUND", `Unknown tool: ${tool}`, [tool]), {
          status: 404,
        });
      }
      if (!found.readOnly) {
        return NextResponse.json(
          fail("METHOD_NOT_ALLOWED", `GET is not supported for tool: ${tool}`, [tool]),
          { status: 405 },
        );
      }

      // M2: query params become the input (digit strings → numbers only
      // where the tool's schema expects a number).
      const rawInput = queryParamsToInput(found.input, new URL(req.url).searchParams);
      return dispatch(tool, rawInput, requestId, req);
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

      return dispatch(tool, rawInput, requestId, req);
    },
  };
}

const { GET, POST } = createRestHandler({ getDb: defaultGetDb });

export { GET, POST };
