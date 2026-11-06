import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    // P5 Task 3: worlds without a treasury_policy row skip the treasury gates in
    // tests (pre-P5 suites use small pools); treasury tests set a row.
    env: { TREASURY_POLICY_DISABLED: "1" },
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx", "tests/integration/**/*.test.ts"],
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
    },
  },
});
