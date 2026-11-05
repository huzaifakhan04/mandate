/**
 * Spike: GET /v1/models from OpenAI, check which model ids from a
 * hypothetical P0 planning list actually exist, and list the closest
 * available chat/reasoning models.
 *
 * Run: npx tsx --env-file=.env.local scripts/spikes/openai-models.ts
 */
import { requireEnv } from "./_helpers";

const WANTED = ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-5.6-sol"];

async function main() {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const t0 = Date.now();

  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = (await res.json()) as { data?: { id: string }[] };
  const ids = (body.data ?? []).map((m) => m.id).sort();

  const found = WANTED.filter((id) => ids.includes(id));
  const missing = WANTED.filter((id) => !ids.includes(id));

  const chatReasoningLike = ids.filter((id) =>
    /^(gpt-5|gpt-4\.1|gpt-4o|o[0-9]|o1|o3|o4)/.test(id),
  );

  console.log(JSON.stringify({ status: res.status, totalModels: ids.length, found, missing, chatReasoningLike, ms: Date.now() - t0 }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
