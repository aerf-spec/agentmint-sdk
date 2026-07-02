// npm run demo:learn
//
// The closing-the-loop demo. An agent misbehaved; the trace demo captured every
// decision as a receipt. Here we feed those receipts to `agentmint learn`, which
// infers the policy that would have stopped the misbehavior AND generates a
// vitest regression suite that replays the incident. We run that suite to prove
// the holes stay closed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJSONL } from "../../src/jsonl.js";
import { inferSpec, countRules, isViolation } from "../../src/experimental/learn.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const receiptsPath = join(here, "out", "receipts.jsonl");
const specPath = "/tmp/learned-policy.yaml";
const testPath = "/tmp/learned-policy.test.ts";

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
}

function main(): void {
  // 1. Produce the receipts by running the trace demo.
  console.log("$ npm run demo:trace  (produces receipts)\n");
  run("npx", ["tsx", join(here, "trace.ts")]);

  // 2. Learn the policy + generate the regression suite from those receipts.
  console.log("\n$ agentmint learn --from examples/demos/out/receipts.jsonl --out ... --test ...\n");
  run("npx", [
    "tsx",
    join(repoRoot, "src/cli/entry.ts"),
    "learn",
    "--from",
    receiptsPath,
    "--out",
    specPath,
    "--test",
    testPath,
  ]);

  // 3. Run the generated regression suite. Throws (non-zero exit) if it fails.
  console.log("\n$ npx vitest run /tmp/learned-policy.test.ts\n");
  run("npx", ["vitest", "run", "--root", "/tmp", testPath]);

  // 4. The punchline, computed from the real artifacts.
  const events = parseJSONL(readFileSync(receiptsPath, "utf-8"));
  const violations = events.filter(isViolation).length;
  const rules = countRules(inferSpec(events));
  console.log(
    `\n${violations} violations -> ${rules} rules -> ${violations} regression tests. all passing.`,
  );
}

main();
