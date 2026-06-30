#!/usr/bin/env node
import { brand, dim, fg, muted, red } from "./color.js";

const cmd = process.argv[2];

const commands: Record<string, () => Promise<void>> = {
  demo: () => import("./demo.js").then((m) => m.runDemo()),
  watch: () => import("./watch.js").then((m) => m.runWatch()),
  init: () => import("./init.js").then((m) => m.runInit()),
  ci: () => import("./ci.js").then((m) => m.runCi()),
  diff: () => import("./diff.js").then((m) => m.runDiff()),
};

function showHelp(): void {
  console.log("");
  console.log(`  ${brand()}  ${dim("v0.1.0")}`);
  console.log(`  ${muted("Runtime guardrails for AI agents")}`);
  console.log("");
  console.log(`  ${fg("Usage:")}  agentmint ${dim("<command>")}`);
  console.log("");
  console.log(`  ${fg("Commands:")}`);
  console.log(`    ${fg("demo")}       ${muted("Run demo scenarios (validation + breakers + receipts)")}`);
  console.log(`    ${fg("watch")}      ${muted("Real-time validation against your spec")}`);
  console.log(`    ${fg("init")}       ${muted("Generate a starter agentmint.spec.yaml")}`);
  console.log(`    ${fg("ci")}         ${muted("Validate receipts against spec (exit 0/1)")}`);
  console.log(`    ${fg("diff")}       ${muted("Compare behavior between two runs")}`);
  console.log(`    ${fg("help")}       ${muted("Show this help message")}`);
  console.log(`    ${fg("version")}    ${muted("Print version number")}`);
  console.log("");
  console.log(`  ${fg("Examples:")}`);
  console.log(`    ${dim("$")} agentmint demo a`);
  console.log(`    ${dim("$")} agentmint init --example coding`);
  console.log(`    ${dim("$")} agentmint watch --spec ./agentmint.spec.yaml`);
  console.log(`    ${dim("$")} agentmint ci --receipt ./receipts/latest.jsonl`);
  console.log(`    ${dim("$")} agentmint diff run1.jsonl run2.jsonl`);
  console.log("");
}

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  showHelp();
} else if (cmd === "version" || cmd === "--version" || cmd === "-v") {
  console.log("0.1.0");
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
