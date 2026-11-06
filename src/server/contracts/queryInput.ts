import type { z } from "zod";

/**
 * M2 (final review): turns a REST `GET /api/v1/{tool}?a=b` query string
 * into the tool's raw input object, so read-only tools with required input
 * (e.g. `get_loan?loan_id=…`, `check_eligibility?amount_cents=1000&term_days=7`)
 * work over GET as advertised.
 *
 * Schema-aware and deliberately narrow: a value is converted to a number
 * ONLY when it is a plain integer digit string AND the tool's schema
 * expects a number for that key. Everything else stays a string, so the
 * tool's own Zod schema still decides validity (no `z.coerce` — `"1e3"`,
 * `""` or `"12abc"` are never silently accepted as numbers). A repeated key
 * keeps its last value.
 */

/** Wrappers that don't change what kind of value the field holds. */
const TRANSPARENT = new Set(["optional", "nullable", "default", "prefault", "readonly", "catch", "nonoptional"]);

interface ZodInternals {
  _zod?: { def?: { type?: string; innerType?: unknown; in?: unknown; shape?: Record<string, unknown> } };
}

function def(schema: unknown) {
  return (schema as ZodInternals)._zod?.def;
}

/** The underlying Zod type name of `schema` (e.g. `"number"`, `"string"`, `"object"`), unwrapping optional/default/pipe. */
function baseType(schema: unknown): string | undefined {
  let current = schema;
  for (let depth = 0; depth < 10; depth += 1) {
    const d = def(current);
    if (!d?.type) {
      return undefined;
    }
    if (TRANSPARENT.has(d.type)) {
      current = d.innerType;
    } else if (d.type === "pipe") {
      current = d.in;
    } else {
      return d.type;
    }
  }
  return undefined;
}

function objectShape(schema: unknown): Record<string, unknown> | undefined {
  let current = schema;
  for (let depth = 0; depth < 10; depth += 1) {
    const d = def(current);
    if (!d?.type) {
      return undefined;
    }
    if (d.type === "object") {
      return d.shape;
    }
    if (TRANSPARENT.has(d.type)) {
      current = d.innerType;
    } else if (d.type === "pipe") {
      current = d.in;
    } else {
      return undefined;
    }
  }
  return undefined;
}

const INTEGER = /^-?\d+$/;

export function queryParamsToInput(schema: z.ZodType, params: URLSearchParams): Record<string, unknown> {
  const shape = objectShape(schema) ?? {};
  const input: Record<string, unknown> = {};
  for (const [key, value] of params) {
    const field = shape[key];
    if (field !== undefined && baseType(field) === "number" && INTEGER.test(value)) {
      input[key] = Number(value);
    } else {
      input[key] = value;
    }
  }
  return input;
}
