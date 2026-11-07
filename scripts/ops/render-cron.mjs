// Render Cron Job entrypoint: POST ${PUBLIC_BASE_URL}/api/cron/<job> with
// `Authorization: Bearer ${CRON_SECRET}` (the contract Vercel Cron used).
// Exits non-zero on failure so Render marks the run as failed.
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

const res = await fetch(new URL(`/api/cron/${job}`, base), {
  method: "POST",
  headers: { authorization: `Bearer ${secret}` },
  signal: AbortSignal.timeout(70_000),
});
const body = await res.text();
console.log(`[cron] ${job} -> ${res.status} ${body.slice(0, 500)}`);
if (!res.ok) process.exit(1);
