#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { brand, dim, fg, muted, red } from "./color.js";

const VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const cmd = process.argv[2];

const commands: Record<string, () => Promise<void>> = {
  verify: () => import("./verify.js").then((m) => m.runVerify()),
  demo: () => import("./demo.js").then((m) => m.runDemo()),
  test: () => import("./test.js").then((m) => m.runTest()),
  gate: () => import("./gate.js").then((m) => m.runGate()),
  scan: () => import("./scan.js").then((m) => m.runScan()),
  learn: () => import("./learn.js").then((m) => m.runLearn()),
  watch: () => import("./watch.js").then((m) => m.runWatch()),
  init: () => import("./init.js").then((m) => m.runInit()),
  ci: () => import("./ci.js").then((m) => m.runCi()),
  diff: () => import("./diff.js").then((m) => m.runDiff()),
};

function showHelp(): void {
  console.log("");
  console.log(`  ${brand()}  ${dim(`v${VERSION}`)}`);
  console.log(`  ${muted("Independent verification for AI agent tool calls")}`);
  console.log("");
  console.log(`  ${fg("Usage:")}  agentmint ${dim("<command>")}`);
  console.log("");
  console.log(`  ${fg("Commands:")}`);
  console.log(`    ${fg("verify")}     ${muted("Independently verify a diff or directory against invariants")}`);
  console.log(`    ${fg("demo")}       ${muted("Run demo scenarios (validation + breakers + receipts)")}`);
  console.log(`    ${fg("test")}       ${muted("Run a pre-built agent test suite")}`);
  console.log(`    ${fg("gate")}       ${muted("Request human approval for an action")}`);
  console.log(`    ${fg("scan")}       ${muted("Auto-generate a spec from your tool source")}`);
  console.log(`    ${fg("learn")}      ${muted("Generate a spec from past violations")}`);
  console.log(`    ${fg("watch")}      ${muted("Real-time validation against your spec")}`);
  console.log(`    ${fg("init")}       ${muted("Generate a starter agentmint.spec.yaml")}`);
  console.log(`    ${fg("ci")}         ${muted("Validate receipts against spec (exit 0/1)")}`);
  console.log(`    ${fg("diff")}       ${muted("Compare behavior between two runs")}`);
  console.log(`    ${fg("help")}       ${muted("Show this help message")}`);
  console.log(`    ${fg("version")}    ${muted("Print version number")}`);
  console.log("");
  console.log(`  ${fg("Examples:")}`);
  console.log(`    ${dim("$")} agentmint verify demo`);
  console.log(`    ${dim("$")} agentmint demo a`);
  console.log(`    ${dim("$")} agentmint test --suite prior-auth`);
  console.log(`    ${dim("$")} agentmint gate --action "deploy" --context '{"env":"production"}'`);
  console.log(`    ${dim("$")} agentmint scan --dir ./src`);
  console.log(`    ${dim("$")} agentmint learn --from receipts/incident.jsonl`);
  console.log(`    ${dim("$")} agentmint init --example coding`);
  console.log(`    ${dim("$")} agentmint watch --spec ./agentmint.spec.yaml`);
  console.log(`    ${dim("$")} agentmint diff run1.jsonl run2.jsonl`);
  console.log("");
}

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  showHelp();
} else if (cmd === "version" || cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
} else if (commands[cmd]) {
  commands[cmd]!().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n  ${red("✗")} ${message}\n`);
    process.exitCode = 1;
  });
} else {
  const known = Object.keys(commands).concat(["help", "version"]);
  const suggestion = known.find((c) => c.startsWith(cmd.toLowerCase()));
  console.error("");
  console.error(`  ${red("✗")} Unknown command: ${red(cmd)}`);
  if (suggestion) {
    console.error(`  ${muted("Did you mean")} ${fg(suggestion)}${muted("?")}`);
    console.error(`\n    ${dim("$")} agentmint ${suggestion}`);
  } else {
    console.error(`  ${muted("Run")} ${fg("agentmint help")} ${muted("to see available commands")}`);
  }
  console.error("");
  process.exitCode = 1;
}
