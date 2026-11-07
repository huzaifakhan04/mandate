import { NextResponse } from "next/server";

import { buildOpenApiDocument } from "@/server/contracts/registry";
import "@/server/contracts/tools";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(buildOpenApiDocument(process.env.PUBLIC_BASE_URL || "http://localhost:3000"));
}
