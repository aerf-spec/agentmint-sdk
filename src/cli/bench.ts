import { writeFileSync } from "node:fs";
import { DEMO_SPEC_YAML, createDemoTools } from "../bench-scenarios.js";
import { formatBenchMarkdown, runBench } from "../bench.js";
import { brand, dim, fg, green, muted, red } from "./color.js";

function showBenchHelp(): void {
  console.log("");
  console.log(`  ${brand()} ${fg("bench")}`);
  console.log("");
  console.log(`  ${muted("Usage:")} agentmint bench ${dim("--framework demo [--json] [--out <file>]")}`);
  console.log("");
  console.log(`  ${muted("Examples:")}`);
  console.log(`    ${dim("$")} agentmint bench --framework demo`);
  console.log(`    ${dim("$")} agentmint bench --framework demo --json`);
  console.log(`    ${dim("$")} agentmint bench --framework demo --out report.md`);
  console.log("");
}

export async function runCliBench(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    showBenchHelp();
    return;
  }

  const frameworkIdx = args.indexOf("--framework");
  const framework = frameworkIdx >= 0 ? args[frameworkIdx + 1] : undefined;
  const jsonMode = args.includes("--json");
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;

  if (!framework) {
    showBenchHelp();
    process.exitCode = 1;
    return;
  }

  if (framework !== "demo") {
    console.error(`\n  ${red("✗")} Unsupported framework: ${red(framework)}\n`);
    process.exitCode = 1;
    return;
  }

  const report = await runBench("demo", createDemoTools(), DEMO_SPEC_YAML);
  const output = jsonMode ? JSON.stringify(report, null, 2) : formatBenchMarkdown(report);

  if (outPath) {
    writeFileSync(outPath, output + "\n");
    console.log(`\n  ${green("✓")} Wrote benchmark report to ${fg(outPath)}\n`);
    return;
  }

  process.stdout.write(output + "\n");
}
