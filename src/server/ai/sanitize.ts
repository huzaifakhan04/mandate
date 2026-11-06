/**
 * Display hygiene for LLM text (P3 Task 4, Task 3 review): role outputs can
 * echo agent-controlled strings (a document's file name, an agent's name),
 * so before any text is stored or shown, URLs are removed and each string
 * is capped. Rendered as plain text only (React escapes it).
 */

/** Per-string cap for KYA findings and loan-officer text. */
export const MAX_NARRATIVE_TEXT = 200;

const URL_RE = /\b(?:https?:\/\/|www\.)\S*/gi;

/**
 * Bare hosts like `evil.com` or `pay.evil.co.uk/claim`: dot-separated
 * labels ending in an all-letter, TLD-like label (2–24 letters), with an
 * optional path. Decimals and amounts ("1.5x", "$0.58", "v2.1") never end
 * in an all-letter label; one-letter labels ("e.g.") are too short; common
 * file extensions (a KYA finding naming "registration.pdf") are kept.
 */
const BARE_HOST_RE = /(?<![\w@.-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.([a-z]{2,24})\b(?:\/\S*)?/gi;
const FILE_EXTENSIONS = new Set([
  "pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "txt", "csv", "json", "md", "doc", "docx", "xls", "xlsx", "zip",
]);

function stripBareHosts(text: string): string {
  return text.replace(BARE_HOST_RE, (match: string, tld: string) =>
    !match.includes("/") && FILE_EXTENSIONS.has(tld.toLowerCase()) ? match : "[link removed]",
  );
}

/** Removes URLs (http(s)://, www., bare hosts), collapses whitespace, and caps at `max` chars. */
export function cleanText(text: string, max: number = MAX_NARRATIVE_TEXT): string {
  const cleaned = stripBareHosts(text.replace(URL_RE, "[link removed]")).replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

/** `cleanText` over a list, dropping strings that end up empty. */
export function cleanList(items: readonly string[], max: number = MAX_NARRATIVE_TEXT): string[] {
  return items.map((item) => cleanText(item, max)).filter((item) => item.length > 0);
}
