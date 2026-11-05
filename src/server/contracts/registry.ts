import { z } from "zod";

import type { Envelope } from "./envelope";

/**
 * Per-request context handed to every tool handler. `worldId`/`simNow` come
 * from the main world's clock (Task 4); `agentId` is `null` until agent auth
 * exists; `requestId` is a fresh id minted per request.
 */
export interface ToolCtx {
  worldId: string;
  simNow: Date;
  agentId: string | null;
  requestId: string;
}

export interface ToolDef<
  Input extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
  Output extends z.ZodType = z.ZodType,
> {
  name: string;
  title: string;
  description: string;
  auth: "none" | "agent";
  mutating: boolean;
  input: Input;
  output: Output;
  handler: (input: z.infer<Input>, ctx: ToolCtx) => Promise<Envelope<unknown>>;
}

/**
 * The contract registry. Order is registration order: tools are added by
 * importing their defining module (see `src/server/contracts/tools/index.ts`),
 * and every consumer (REST, MCP, OpenAPI, tests) imports that module first so
 * the registry is populated before it is read.
 */
export const registry: ToolDef[] = [];

/** Registers a tool definition and returns it unchanged. */
export function defineTool<
  Input extends z.ZodObject<z.ZodRawShape>,
  Output extends z.ZodType,
>(def: ToolDef<Input, Output>): ToolDef<Input, Output> {
  registry.push(def as unknown as ToolDef);
  return def;
}

/** Looks up a tool by name, or `undefined` if no such tool is registered. */
export function findTool(name: string): ToolDef | undefined {
  return registry.find((tool) => tool.name === name);
}

/** JSON Schema for the envelope shape, reused across every OpenAPI response. */
const envelopeJsonSchema = {
  type: "object",
  required: ["status", "summary", "reason_codes", "data", "next_actions", "docs_url"],
  properties: {
    status: { type: "string" },
    summary: { type: "string" },
    reason_codes: { type: "array", items: { type: "string" } },
    data: { type: "object" },
    next_actions: {
      type: "array",
      items: {
        type: "object",
        required: ["tool", "args"],
        properties: {
          tool: { type: "string" },
          args: { type: "object" },
        },
      },
    },
    docs_url: { type: "string" },
  },
} as const;

/**
 * Builds the OpenAPI 3.1 document for the registry: one `POST /api/v1/{name}`
 * path per registered tool. Request bodies come from `z.toJSONSchema(input)`;
 * every response uses the shared envelope schema.
 */
export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};

  for (const tool of registry) {
    paths[`/api/v1/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.title,
        description: tool.description,
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: z.toJSONSchema(tool.input) },
          },
        },
        responses: {
          "200": {
            description: "Envelope response",
            content: { "application/json": { schema: envelopeJsonSchema } },
          },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: { title: "Mandate Bank API", version: "1.0.0" },
    paths,
  };
}
