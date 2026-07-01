import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  verify,
  demoReceipt,
  formatVerifyReceipt,
  formatVerifyJSONL,
  type VerifyInput,
} from "../verify.js";
import { brand, dim, fg, muted, red } from "./color.js";

interface Args {
  demo: boolean;
  dir?: string;
  spec?: string;
  diff?: string;
  context?: string;
  schemaDir?: string;
  mode?: "shadow" | "enforce";
  json: boolean;
  jsonl: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { demo: false, json: false, jsonl: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "demo") args.demo = true;
    else if (a === "--dir") args.dir = argv[++i];
    else if (a === "--spec") args.spec = argv[++i];
    else if (a === "--diff") args.diff = argv[++i];
    else if (a === "--context") args.context = argv[++i];
    else if (a === "--schema-dir") args.schemaDir = argv[++i];
    else if (a === "--mode") args.mode = argv[++i] as "shadow" | "enforce";
    else if (a === "--json") args.json = true;
    else if (a === "--jsonl") args.jsonl = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function showHelp(): void {
  console.log("");
  console.log(`  ${brand()}  ${dim("verify")}`);
  console.log(`  ${muted("Independent verification for AI agent tool calls")}`);
  console.log("");
  console.log(`  ${fg("Usage:")}  agentmint verify ${dim("[demo] [options]")}`);
  console.log("");
  console.log(`  ${fg("Options:")}`);
  console.log(`    ${fg("--dir")}         ${muted("Directory of source to verify")}`);
  console.log(`    ${fg("--diff")}        ${muted("Git ref (e.g. HEAD~1), diff file, or diff content")}`);
  console.log(`    ${fg("--spec")}        ${muted("Path to agentmint.spec.yaml")}`);
  console.log(`    ${fg("--context")}     ${muted("Ticket / PR description text")}`);
  console.log(`    ${fg("--schema-dir")}  ${muted("Directory with type definitions")}`);
  console.log(`    ${fg("--json")}        ${muted("Emit the full receipt as JSON")}`);
  console.log(`    ${fg("--jsonl")}       ${muted("Emit one JSONL event per claim")}`);
  console.log("");
  console.log(`  ${fg("Examples:")}`);
  console.log(`    ${dim("$")} agentmint verify demo`);
  console.log(`    ${dim("$")} agentmint verify --dir ./src --spec agentmint.spec.yaml`);
  console.log(`    ${dim("$")} agentmint verify --diff HEAD~1 --context "fix refund bug"`);
  console.log(`    ${dim("$")} agentmint verify --dir ./src --json`);
  console.log("");
}

/** If --diff is a git ref (not a file, not raw diff text), materialize it via git. */
function resolveDiff(value: string): string {
  const looksLikeDiff = value.includes("\n") || value.includes("diff --git");
  if (looksLikeDiff || existsSync(value)) return value;
  try {
    return execFileSync("git", ["diff", value], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    // Not a valid ref — pass through and let verify() treat it as content.
    return value;
  }
}

export async function runVerify(): Promise<void> {
  const args = parseArgs(process.argv.slice(3));

  if (args.help) {
    showHelp();
    return;
  }

  if (!args.demo && !args.dir && !args.diff) {
    console.error("");
    console.error(`  ${red("✗")} ${fg("agentmint verify")} needs ${fg("demo")}, ${fg("--dir")}, or ${fg("--diff")}`);
    console.error(`  ${muted("Run")} ${fg("npx @npmsai/agentmint verify --help")} ${muted("for usage.")}`);
    console.error("");
    process.exitCode = 1;
    return;
  }

  const receipt = args.demo
    ? demoReceipt()
    : await verify({
        dir: args.dir,
        spec: args.spec,
        diff: args.diff ? resolveDiff(args.diff) : undefined,
        context: args.context,
        schemaDir: args.schemaDir,
        mode: args.mode,
      } satisfies VerifyInput);

  if (args.json) {
    console.log(JSON.stringify(receipt, null, 2));
  } else if (args.jsonl) {
    console.log(formatVerifyJSONL(receipt));
  } else {
    console.log(formatVerifyReceipt(receipt));
  }

  // In enforce mode, exit non-zero when there is something a human must act on.
  // Shadow mode (the default, and the demo) always exits 0.
  if (args.mode === "enforce" && (receipt.summary.failed > 0 || receipt.summary.blocked > 0)) {
    process.exitCode = 1;
  }
}
