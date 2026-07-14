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
  export: () => import("./export.js").then((m) => m.runExport()),
};

function showHelp(): void {
  console.log("");
  console.log(`  ${brand()}  ${dim(`v${VERSION}`)}`);
  console.log(`  ${muted("Signs every agent action into a receipt you can verify later.")}`);
  console.log("");
  console.log(`  ${fg("Usage:")}  npx @npmsai/agentmint ${dim("<command>")}`);
  console.log("");
  console.log(`  ${fg("Commands:")}`);
  console.log(`    ${muted("Instrument")}`);
  console.log(`    ${fg("init")}       ${muted("Write a starter agentmint.spec.yaml for your agent.")}`);
  console.log(`    ${fg("demo")}       ${muted("Run the prior auth walkthrough with no keys and no network.")}`);
  console.log("");
  console.log(`    ${muted("Observe")}`);
  console.log(`    ${fg("watch")}      ${muted("Validate your agent's calls against your spec as they happen.")}`);
  console.log("");
  console.log(`    ${muted("Prove")}`);
  console.log(`    ${fg("export")}     ${muted("Bundle receipts into an evidence zip your buyer verifies alone.")}`);
  console.log(`    ${fg("verify")}     ${muted("Check a signed receipt chain, or a code change, against its invariants.")}`);
  console.log(`    ${fg("ci")}         ${muted("Validate receipts against a spec and exit 0 or 1 for CI.")}`);
  console.log(`    ${fg("diff")}       ${muted("Compare the behavior of two runs.")}`);
  console.log("");
  console.log(`    ${muted("Improve")}`);
  console.log(`    ${fg("learn")}      ${muted("Write the spec that would have caught your past violations.")}`);
  console.log(`    ${fg("scan")}       ${muted("Draft a spec from your source. Folding into learn in a later release.")}`);
  console.log(`    ${fg("test")}       ${muted("Run a pre-built agent test suite.")}`);
  console.log(`    ${fg("gate")}       ${muted("Request human approval before a high-risk action runs.")}`);
  console.log("");
  console.log(`    ${fg("help")}       ${muted("Show this help message.")}`);
  console.log(`    ${fg("version")}    ${muted("Print the version number.")}`);
  console.log("");
  console.log(`  ${fg("Examples:")}`);
  console.log(`    ${dim("$")} npx @npmsai/agentmint demo`);
  console.log(`    ${dim("$")} npx @npmsai/agentmint init --template rcm`);
  console.log(`    ${dim("$")} npx @npmsai/agentmint export --from receipts/ --out evidence.zip`);
  console.log(`    ${dim("$")} npx @npmsai/agentmint verify --receipts receipts/ --pub public_key.pem`);
  console.log("");
  console.log(`  ${muted("Next: run")} ${fg("agentmint demo")} ${muted("to see a receipted prior auth session end to end.")}`);
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
    console.error(`\n    ${dim("$")} npx @npmsai/agentmint ${suggestion}`);
  } else {
    console.error(`  ${muted("Run")} ${fg("npx @npmsai/agentmint help")} ${muted("to see available commands")}`);
  }
  console.error("");
  process.exitCode = 1;
}
