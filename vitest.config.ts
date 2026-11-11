import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "app/**/*.test.ts", "agents/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The signer is a real child process per test file; keep files serial so
    // latency assertions are not measured against a saturated CPU.
    fileParallelism: false,
  },
});
