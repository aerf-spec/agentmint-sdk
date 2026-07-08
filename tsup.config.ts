import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/experimental/vercel/index.ts",
    "src/experimental/enforce.ts",
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
    "src/experimental/suites/prior-auth.ts",
    "src/experimental/suites/coding-agent.ts",
    "src/experimental/suites/refund-agent.ts",
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
