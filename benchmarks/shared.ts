import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { harden, loadSpec, type RunState } from "../src/index.ts";

export type ToolMap = Record<string, (params: Record<string, unknown>) => Promise<unknown>>;

export type HardenedToolMap<T extends ToolMap> = T & {
  __state(): RunState;
};

export interface ScenarioOutcome {
  caught: boolean;
  details: string;
  latencyUs?: number;
}

export interface HarnessScenario<T extends ToolMap> {
  id: string;
  area: string;
  name: string;
  expectedAgentMintCatch: boolean;
  runRaw(tools: T): Promise<ScenarioOutcome>;
  runAgentMint(tools: HardenedToolMap<T>): Promise<ScenarioOutcome>;
}

export interface OverviewRow {
  property: string;
  framework: string;
  agentmint: string;
  notSolved: string;
}

export interface HarnessResult {
  id: string;
  area: string;
  name: string;
  frameworkCaught: boolean;
  agentmintCaught: boolean;
  falsePositive: boolean;
  details: string;
  latencyUs?: number;
}

export interface HarnessReport {
  framework: string;
  scenarioCount: number;
  results: HarnessResult[];
  overheadUs: number;
  reproduceCmd: string;
  overview: OverviewRow[];
}

export function cloneTools<T extends ToolMap>(tools: T): T {
  return { ...tools };
}

export function isBlockedResponse(value: unknown): value is { error: true; tool: string; message: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      "error" in value &&
      (value as Record<string, unknown>).error === true,
  );
}

export function snapshot(state: RunState): RunState {
  return {
    ...state,
    completedSteps: new Set(state.completedSteps),
    events: [...state.events],
    retryCounts: { ...state.retryCounts },
    session: {
      inputs: new Map(state.session.inputs),
      outputs: new Map(state.session.outputs),
      callHistory: [...state.session.callHistory],
    },
  };
}

export function stateDelta(before: RunState, after: RunState): {
  blocked: number;
  warned: number;
  events: number;
} {
  return {
    blocked: after.blockedCount - before.blockedCount,
    warned: after.warnedCount - before.warnedCount,
    events: after.events.length - before.events.length,
  };
}

export function describeState(state: RunState, fallback: string): string {
  const last = state.events.at(-1);
  if (!last) return fallback;
  return last.details
    ? `${last.result} (${last.reason ?? "n/a"}: ${last.details})`
    : `${last.result} (${last.reason ?? "n/a"})`;
}

export async function measureOverhead<T extends ToolMap>(
  rawToolsFactory: () => T,
  benchTool: keyof T & string,
  makeParams: (i: number) => Record<string, unknown>,
  iterations = 100,
): Promise<number> {
  const rawTools = rawToolsFactory();
  const rawStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    await rawTools[benchTool](makeParams(i));
  }
  const rawMs = performance.now() - rawStart;

  const hardened = harden(rawToolsFactory(), { silent: true }) as HardenedToolMap<T>;
  const hardenedStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    await hardened[benchTool](makeParams(i));
  }
  const hardenedMs = performance.now() - hardenedStart;

  return Math.max(1, Math.round(((hardenedMs - rawMs) / iterations) * 1000));
}

export async function runHarness<T extends ToolMap>(options: {
  framework: string;
  specYaml: string;
  rawToolsFactory: () => T;
  scenarios: Array<HarnessScenario<T>>;
  reproduceCmd: string;
  overview: OverviewRow[];
}): Promise<HarnessReport> {
  const parsedSpec = loadSpec(options.specYaml);
  const results: HarnessResult[] = [];

  for (const scenario of options.scenarios) {
    const rawOutcome = await scenario.runRaw(options.rawToolsFactory());
    const hardened = harden(options.rawToolsFactory(), {
      spec: parsedSpec,
      silent: true,
    }) as HardenedToolMap<T>;
    const agentmintOutcome = await scenario.runAgentMint(hardened);
    results.push({
      id: scenario.id,
      area: scenario.area,
      name: scenario.name,
      frameworkCaught: rawOutcome.caught,
      agentmintCaught: agentmintOutcome.caught,
      falsePositive: !scenario.expectedAgentMintCatch && agentmintOutcome.caught,
      details: `framework=${rawOutcome.details} | agentmint=${agentmintOutcome.details}`,
      latencyUs: agentmintOutcome.latencyUs,
    });
  }

  return {
    framework: options.framework,
    scenarioCount: results.length,
    results,
    overheadUs: results.find((result) => result.latencyUs !== undefined)?.latencyUs ?? 0,
    reproduceCmd: options.reproduceCmd,
    overview: options.overview,
  };
}

export function formatHarnessTable(report: HarnessReport): string {
  const lines = [
    "| ID | Area | Scenario | Framework | AgentMint | FP? |",
    "|----|------|----------|-----------|-----------|-----|",
  ];
  for (const result of report.results) {
    lines.push(
      `| ${result.id} | ${result.area} | ${result.name} | ${result.frameworkCaught ? "YES" : "NO"} | ${result.agentmintCaught ? "YES" : "NO"} | ${result.falsePositive ? "Yes" : "No"} |`,
    );
  }
  return lines.join("\n");
}

export function formatOverviewTable(rows: OverviewRow[]): string {
  const lines = [
    "| Property | Framework native | AgentMint adds | AgentMint does not solve |",
    "|----------|------------------|----------------|--------------------------|",
  ];
  for (const row of rows) {
    lines.push(`| ${row.property} | ${row.framework} | ${row.agentmint} | ${row.notSolved} |`);
  }
  return lines.join("\n");
}

export function formatHarnessMarkdown(report: HarnessReport): string {
  const frameworkCaught = report.results.filter((result) => result.frameworkCaught).length;
  const agentmintCaught = report.results.filter((result) => result.agentmintCaught).length;
  const falsePositives = report.results.filter((result) => result.falsePositive).length;
  return [
    `# ${report.framework} Governance Benchmark`,
    "",
    "## Summary",
    "| Metric | Value |",
    "|--------|-------|",
    `| Scenarios | ${report.scenarioCount} |`,
    `| Framework catches | ${frameworkCaught} |`,
    `| AgentMint catches | ${agentmintCaught} |`,
    `| False positives | ${falsePositives} |`,
    `| Overhead | ~${report.overheadUs}us/call |`,
    "",
    "## Governance Matrix",
    formatOverviewTable(report.overview),
    "",
    "## Results",
    formatHarnessTable(report),
    "",
    "## How to reproduce",
    report.reproduceCmd,
  ].join("\n");
}

export function writeResultsFile(importMetaUrl: string, markdown: string): void {
  const dir = dirname(fileURLToPath(importMetaUrl));
  writeFileSync(join(dir, "results.md"), markdown + "\n");
}
