/**
 * Names for the one-time API key reveal (see `reveal.ts`), kept free of
 * imports so `src/proxy.ts` can use them.
 */
export const REVEAL_COOKIE_NAME = "mandate_reveal";
export const REVEAL_COOKIE_PATH = "/dashboard/agents";
/** The request header `src/proxy.ts` moves the sealed cookie into for the key page. */
export const REVEAL_HEADER_NAME = "x-mandate-reveal";
