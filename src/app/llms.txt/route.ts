import { NextResponse } from "next/server";

import { renderLlmsTxt } from "@/server/contracts/docs";

/** `${PUBLIC_BASE_URL}`, falling back to `http://localhost:3000`. */
function baseUrl(): string {
  return process.env.PUBLIC_BASE_URL || "http://localhost:3000";
}

export async function GET(): Promise<NextResponse> {
  const body = renderLlmsTxt(baseUrl());
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
