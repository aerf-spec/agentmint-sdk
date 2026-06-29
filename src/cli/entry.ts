#!/usr/bin/env node
import { brand, dim, fg, muted, red } from "./color.js";

const cmd = process.argv[2];

if (cmd === "demo") {
  import("./demo.js").then((m) => m.runDemo());
} else if (cmd === "help" || cmd === "--help" || cmd === "-h" || !cmd) {
  console.log("");
  console.log(`  ${brand()}  ${dim("v0.1.0")}`);
  console.log(`  ${muted("Runtime guardrails for AI agents")}`);
  console.log("");
  console.log(`  ${fg("Usage:")}  agentmint ${dim("<command>")}`);
  console.log("");
  console.log(`  ${fg("Commands:")}`);
  console.log(`    ${fg("demo")}       ${muted("Run a simulated prior auth scenario")}`);
  console.log(`    ${fg("help")}       ${muted("Show this help message")}`);
  console.log(`    ${fg("version")}    ${muted("Print version number")}`);
  console.log("");
  console.log(`  ${fg("Examples:")}`);
  console.log(`    ${dim("$")} agentmint demo`);
  console.log("");
} else if (cmd === "version" || cmd === "--version" || cmd === "-v") {
  console.log("0.1.0");
} else {
  const commands = ["demo", "help", "version"];
  const suggestion = commands.find((c) => c.startsWith(cmd.slice(0, 2))) ?? "demo";
  console.error("");
  console.error(`  ${red("✗")} Unknown command: ${red(cmd)}`);
  if (suggestion) {
    console.error(`  ${muted("Did you mean")} ${fg(suggestion)}${muted("?")}`);
    console.error("");
    console.error(`    ${dim("$")} agentmint ${suggestion}`);
  } else {
    console.error(
      `  ${muted("Run")} ${fg("agentmint help")} ${muted("to see available commands")}`,
    );
  }
  console.error("");
  process.exitCode = 1;
}
