/**
 * Display hygiene for LLM text (P3 Task 4, Task 3 review): role outputs can
 * echo agent-controlled strings (a document's file name, an agent's name),
 * so before any text is stored or shown, URLs are removed and each string
 * is capped. Rendered as plain text only (React escapes it).
 */

/** Per-string cap for KYA findings and loan-officer text. */
export const MAX_NARRATIVE_TEXT = 200;

const URL_RE = /\b(?:https?:\/\/|www\.)\S*/gi;

/** Removes http(s):// and www. URLs, collapses whitespace, and caps at `max` chars. */
export function cleanText(text: string, max: number = MAX_NARRATIVE_TEXT): string {
  const cleaned = text.replace(URL_RE, "[link removed]").replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

/** `cleanText` over a list, dropping strings that end up empty. */
export function cleanList(items: readonly string[], max: number = MAX_NARRATIVE_TEXT): string[] {
  return items.map((item) => cleanText(item, max)).filter((item) => item.length > 0);
}
