import { runSuite, type Scenario, type SuiteResult } from "../experimental/test-runner.js";
import { brand, dim, fg, green, muted, red, yellow } from "./color.js";

const SUITES: Record<string, () => Promise<{ scenarios: Scenario[] }>> = {
  "prior-auth": () => import("../experimental/suites/prior-auth.js"),
  "coding-agent": () => import("../experimental/suites/coding-agent.js"),
  "refund-agent": () => import("../experimental/suites/refund-agent.js"),
};

function parseArgs(argv: string[]): {
  suite?: string;
  json: boolean;
  list: boolean;
} {
  let suite: string | undefined;
  let json = false;
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--suite") suite = argv[++i];
    else if (a === "--json") json = true;
    else if (a === "--list") list = true;
  }
  return { suite, json, list };
}

function printList(): void {
  console.log("");
  console.log(`  ${fg("Available suites:")}`);
  for (const name of Object.keys(SUITES)) {
    console.log(`    ${fg(name)}`);
  }
  console.log("");
}

export async function runTest(): Promise<void> {
  const { suite, json, list } = parseArgs(process.argv.slice(3));

  if (list) {
    printList();
    return;
  }

  if (!suite) {
    console.error("");
    console.error(`  ${red("✗")} ${fg("agentmint test")} requires ${fg("--suite <name>")}`);
    console.error(`  ${muted("Run")} ${fg("npx @npmsai/agentmint test --list")} ${muted("to see available suites.")}`);
    console.error("");
    process.exitCode = 1;
    return;
  }

  const loader = SUITES[suite];
  if (!loader) {
    console.error("");
    console.error(`  ${red("✗")} Unknown suite: ${red(suite)}`);
    console.error(`  ${muted("Available:")} ${Object.keys(SUITES).join(", ")}`);
    console.error("");
    process.exitCode = 1;
    return;
  }

  const { scenarios } = await loader();
  const result = await runSuite(scenarios);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(suite, result);
  }

  if (result.failed > 0) process.exitCode = 1;
}

function printHuman(suite: string, result: SuiteResult): void {
  console.log("");
  console.log(`  ${brand()}  ${dim("test")}  ${fg(suite)}`);
  console.log("");
  for (const r of result.results) {
    const mark = r.passed ? green("✓") : red("✗");
    const label = r.passed
      ? muted(`${r.actual}`)
      : yellow(`expected ${r.expected}, got ${r.actual}`);
    console.log(`    ${mark} ${fg(r.name)} ${dim("·")} ${muted(r.description)}  ${label}`);
  }
  console.log("");
  const summary = `${result.passed}/${result.total} passed`;
  if (result.failed === 0) {
    console.log(`  ${green("✓")} ${fg(summary)}`);
  } else {
    console.log(`  ${red("✗")} ${fg(summary)} ${muted(`(${result.failed} failed)`)}`);
  }
  console.log("");
}
