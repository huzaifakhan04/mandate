import { NextResponse } from "next/server";

import { renderAgentsMd } from "@/server/contracts/docs";
import { knownStatusTable } from "@/server/contracts/envelope";
import { registry } from "@/server/contracts/registry";
import "@/server/contracts/tools";

/** `${PUBLIC_BASE_URL}`, falling back to `http://localhost:3000`. */
function baseUrl(): string {
  return process.env.PUBLIC_BASE_URL || "http://localhost:3000";
}

export async function GET(): Promise<NextResponse> {
  const body = renderAgentsMd(registry, baseUrl(), knownStatusTable());
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
