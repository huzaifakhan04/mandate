import { NextResponse } from "next/server";

/**
 * Minimal PayPal webhook receiver stub for Phase 0 — accepts any POST so
 * PayPal's webhook registration succeeds and day-1 spikes can confirm
 * delivery. Full signature verification (per PAYPAL-TRANSMISSION-SIG /
 * PAYPAL-CERT-URL) and event handling land in P1.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let eventType: string | undefined;
  try {
    const body = (await req.json()) as { event_type?: string };
    eventType = body?.event_type;
  } catch {
    // Non-JSON or empty body — still acknowledge receipt.
  }

  console.log("[paypal-webhook] received", {
    eventType,
    at: new Date().toISOString(),
  });

  return NextResponse.json({ received: true }, { status: 200 });
}
