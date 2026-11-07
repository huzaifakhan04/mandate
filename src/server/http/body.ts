/**
 * P8 (parked since P2): body-size caps enforced WHILE streaming. A
 * `Content-Length` check alone is not enough — a chunked request has none,
 * and `request.formData()` / `.json()` would buffer an unbounded body.
 * `bufferRequestCapped` counts the bytes as they arrive from the body
 * reader and cancels the stream the moment the cap is passed.
 */

/** The body's bytes, or `null` as soon as more than `maxBytes` have arrived (the stream is cancelled). */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return null;
  }
  if (!request.body) {
    return new Uint8Array(0);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * A copy of `request` whose body is the already-read bytes (same URL,
 * method and headers), so the usual `formData()` / `json()` parsers run on
 * a bounded buffer. `null` when the body is over `maxBytes`.
 */
export async function bufferRequestCapped(request: Request, maxBytes: number): Promise<Request | null> {
  const bytes = await readBodyCapped(request, maxBytes);
  if (!bytes) {
    return null;
  }
  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const headers = new Headers(request.headers);
  // The buffered copy is no longer chunked; its length is the bytes we hold.
  headers.delete("transfer-encoding");
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: hasBody ? (bytes as BodyInit) : undefined,
  });
}
