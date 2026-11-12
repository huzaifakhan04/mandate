// Render Cron Job entrypoint: POST ${PUBLIC_BASE_URL}/api/cron/<job> with
// `Authorization: Bearer ${CRON_SECRET}`.
// Exits non-zero on failure so Render marks the run as failed.
//
// Transient failures (network error, per-attempt timeout, 5xx — e.g. Render's
// proxy answering 502/503 or a request that hangs) are retried a couple of
// times before the run is marked failed. Both jobs are safe to re-run: money-
// moving work is claimed atomically (paypal_operations), so an attempt that
// overlaps an abandoned, still-running one cannot double-execute anything.
// Auth/4xx errors are not retried.
const job = process.argv[2];
if (job !== "tick" && job !== "reconcile") {
  console.error("usage: node scripts/ops/render-cron.mjs <tick|reconcile>");
  process.exit(2);
}
const base = process.env.PUBLIC_BASE_URL;
const secret = process.env.CRON_SECRET;
if (!base || !secret) {
  console.error("[cron] PUBLIC_BASE_URL and CRON_SECRET must be set");
  process.exit(2);
}

const MAX_ATTEMPTS = Number(process.env.CRON_MAX_ATTEMPTS ?? 3);
const ATTEMPT_TIMEOUT_MS = Number(process.env.CRON_ATTEMPT_TIMEOUT_MS ?? 60_000);
const RETRY_DELAY_MS = Number(process.env.CRON_RETRY_DELAY_MS ?? 5_000);

const url = new URL(`/api/cron/${job}`, base);

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const tag = `[cron] ${job} (attempt ${attempt}/${MAX_ATTEMPTS})`;
  let retryable;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    const body = await res.text();
    console.log(`${tag} -> ${res.status} ${body.slice(0, 500)}`);
    if (res.ok) process.exit(0);
    retryable = res.status >= 500;
  } catch (err) {
    const reason =
      err?.name === "TimeoutError"
        ? `no response within ${ATTEMPT_TIMEOUT_MS} ms`
        : `${err?.name ?? "Error"}: ${err?.message ?? err}${err?.cause?.code ? ` (${err.cause.code})` : ""}`;
    console.error(`${tag} -> ${reason}`);
    retryable = true;
  }
  if (!retryable || attempt === MAX_ATTEMPTS) break;
  await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
}
console.error(`[cron] ${job} failed`);
process.exit(1);
