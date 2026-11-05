import { NextResponse } from "next/server";

import { buildOpenApiDocument } from "@/server/contracts/registry";
import "@/server/contracts/tools";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(buildOpenApiDocument());
}
