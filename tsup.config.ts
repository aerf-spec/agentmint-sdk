import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli/entry.ts",
    "src/cli/demo.ts",
    "src/cli/watch.ts",
    "src/cli/init.ts",
    "src/cli/ci.ts",
    "src/cli/diff.ts",
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
