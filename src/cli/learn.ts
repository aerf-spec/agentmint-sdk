import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJSONL } from "../jsonl.js";
import { loadSpec } from "../kernel/spec.js";
import { inferSpec, mergeSpecs, serializeSpec, generateTestFile, isViolation } from "../experimental/learn.js";
import type { JSONLEvent } from "../types.js";
import { brand, dim, fg, green, muted, red } from "./color.js";

function parseArgs(argv: string[]): {
  from?: string;
  out?: string;
  merge?: string;
  test?: string;
  help: boolean;
} {
  let from: string | undefined;
  let out: string | undefined;
  let merge: string | undefined;
  let test: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") from = argv[++i];
    else if (a === "--out") out = argv[++i];
    else if (a === "--merge") merge = argv[++i];
    else if (a === "--test") test = argv[++i];
    else if (a === "--help" || a === "-h") help = true;
  }
  return { from, out, merge, test, help };
}

function showHelp(): void {
  console.log("");
  console.log(`  ${brand()}  ${dim("learn")}`);
  console.log(`  ${muted("Generate an agentmint spec from past violations")}`);
  console.log("");
  console.log(`  ${fg("Usage:")}  agentmint learn --from ${dim("<path>")} [--out ${dim("<path>")}] [--merge ${dim("<path>")}] [--test ${dim("<path>")}]`);
  console.log("");
  console.log(`  ${fg("Options:")}`);
  console.log(`    ${fg("--from")}   ${muted("JSONL file or directory of JSONL receipts (required)")}`);
  console.log(`    ${fg("--out")}    ${muted("Write the spec to a file (default: stdout)")}`);
  console.log(`    ${fg("--merge")}  ${muted("Merge inferred rules into an existing spec, preserving it")}`);
  console.log(`    ${fg("--test")}   ${muted("Generate a vitest regression suite that replays the receipts")}`);
  console.log("");
  console.log(`  ${fg("Examples:")}`);
  console.log(`    ${dim("$")} agentmint learn --from receipts/incident.jsonl`);
  console.log(`    ${dim("$")} agentmint learn --from receipts/ --out agentmint.spec.yaml`);
  console.log(`    ${dim("$")} agentmint learn --from receipts/ --merge agentmint.spec.yaml`);
  console.log(`    ${dim("$")} agentmint learn --from receipts/incident.jsonl --test policy.test.ts`);
  console.log("");
}

function collectJSONL(path: string): JSONLEvent[] {
  const events: JSONLEvent[] = [];
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry.endsWith(".jsonl")) {
        events.push(...parseJSONL(readFileSync(join(path, entry), "utf-8")));
      }
    }
  } else {
    events.push(...parseJSONL(readFileSync(path, "utf-8")));
  }
  return events;
}

export async function runLearn(): Promise<void> {
  const { from, out, merge, test, help } = parseArgs(process.argv.slice(3));

  if (help || !from) {
    showHelp();
    if (!from && !help) process.exitCode = 1;
    return;
  }

  let events: JSONLEvent[];
  try {
    events = collectJSONL(from);
  } catch (err) {
    console.error("");
    console.error(`  ${red("✗")} Could not read ${red(from)}: ${err instanceof Error ? err.message : String(err)}`);
    console.error("");
    process.exitCode = 1;
    return;
  }

  let spec = inferSpec(events);

  if (merge) {
    try {
      const existing = loadSpec(readFileSync(merge, "utf-8"));
      spec = mergeSpecs(existing, spec);
    } catch (err) {
      console.error("");
      console.error(`  ${red("✗")} Could not merge with ${red(merge)}: ${err instanceof Error ? err.message : String(err)}`);
      console.error("");
      process.exitCode = 1;
      return;
    }
  }

  const yaml = serializeSpec(spec);

  if (out) {
    writeFileSync(out, yaml, "utf-8");
    const toolCount = spec.tools ? Object.keys(spec.tools).length : 0;
    console.error(`  ${green("✓")} Wrote spec (${toolCount} tool${toolCount === 1 ? "" : "s"}) to ${fg(out)}`);
  } else if (!test) {
    process.stdout.write(yaml);
  }

  if (test) {
    const violations = events.filter(isViolation).length;
    const source = new Date().toISOString();
    // Point the generated test at the SDK entry this CLI is running from, so it
    // is runnable standalone (`npx vitest run <file> --root <dir>`) with no edits
    // and no dependency on the package being installed under the test's path.
    const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const importSpecifier = fileURLToPath(new URL(`../index${ext}`, import.meta.url));
    const content = generateTestFile({
      events,
      spec,
      fromPath: from,
      testPath: test,
      timestamp: source,
      importSpecifier,
    });
    writeFileSync(test, content, "utf-8");
    console.error(
      `  ${green("✓")} Wrote ${violations} regression test${violations === 1 ? "" : "s"} to ${fg(test)}`,
    );
  }
}
