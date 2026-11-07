import { NextResponse } from "next/server";

import { isAuthorizedCron } from "@/server/jobs/cronHandler";

// TEMPORARY (Render migration): shows which client-IP headers the host's
// proxy sends, so rate limiting can key on a trusted one. CRON_SECRET-gated.
const NAMES = ["x-forwarded-for", "x-real-ip", "true-client-ip", "cf-connecting-ip", "x-forwarded-proto", "cf-ray", "rndr-id"];

export async function GET(req: Request): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(Object.fromEntries(NAMES.map((n) => [n, req.headers.get(n)])));
}
