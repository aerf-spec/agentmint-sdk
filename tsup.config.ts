import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/bench.ts",
    "src/cli/bench.ts",
    "src/cli/entry.ts",
    "src/cli/verify.ts",
    "src/cli/demo.ts",
    "src/cli/test.ts",
    "src/cli/gate.ts",
    "src/cli/scan.ts",
    "src/cli/learn.ts",
    "src/cli/watch.ts",
    "src/cli/init.ts",
    "src/cli/ci.ts",
    "src/cli/diff.ts",
    "src/suites/prior-auth.ts",
    "src/suites/coding-agent.ts",
    "src/suites/refund-agent.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  outDir: "dist",
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".js",
    };
  },
});
