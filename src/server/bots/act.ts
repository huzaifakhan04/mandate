import "../contracts/tools";
import type { Envelope } from "../contracts/envelope";
import { findTool } from "../contracts/registry";
import { runTool } from "../contracts/runTool";
import type { Db } from "../db/client";

/**
 * P2 Task 6: a bot calls the same tools an agent would, through
 * `runTool` — same validation, tier gate, mandate checks, idempotency,
 * after-commit PayPal (here: sim) execution. `actingBotId` replaces the
 * API key (bots have none) and is accepted only for `is_bot` agents.
 */
export async function botCall(
  db: Db,
  botId: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<Envelope<unknown>> {
  const result = await runTool(findTool(toolName), toolName, input, {
    getDb: async () => db,
    actingBotId: botId,
  });
  return result.envelope;
}

export type Data = Record<string, unknown>;

export function dataOf(envelope: Envelope<unknown>): Data {
  return (envelope.data ?? {}) as Data;
}

/** What a bot did on a day, for the `bot.day` event and the world page. */
export interface BotAction {
  bot: string;
  action: string;
  amountCents?: number;
  status: string;
}
