import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Keep the dev-mode indicator out of Playwright screenshots (P2 Task 5).
  devIndicators: false,
  // Dev-only PGlite fallback (see getDb): load it from node_modules rather
  // than bundling it, so its wasm/data files resolve in every server bundle
  // (an app page bundle couldn't load them). Production never imports it.
  serverExternalPackages: ["@electric-sql/pglite"],
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
