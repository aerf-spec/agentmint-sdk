import { createBenchToolsFromSpec, getBuiltInBenchScenarios } from "./bench-scenarios.js";

export interface BenchResult {
  id: string;
  category: "policy" | "enforcement" | "audit" | "breaker" | "clean" | "latency";
  name: string;
  framework_catches: boolean;
  agentmint_catches: boolean;
  false_positive: boolean;
  details: string;
  latency_us?: number;
}

export interface BenchReport {
  framework: string;
  timestamp: string;
  total: number;
  results: BenchResult[];
  summary: {
    framework_caught: number;
    agentmint_caught: number;
    gaps: number;
    false_positives: number;
    latency_us: number;
  };
}

type RawToolMap = Record<string, (...args: any[]) => Promise<unknown>>;

function cloneTools<T extends RawToolMap>(tools: T): T {
  return { ...tools };
}

function renderCatch(caught: boolean): string {
  return caught ? "YES" : "NO";
}

function renderFalsePositive(value: boolean): string {
  return value ? "Yes" : "No";
}

export async function runBench(
  framework: string,
  rawTools: Record<string, Function>,
  specYaml: string,
): Promise<BenchReport> {
  const scenarios = getBuiltInBenchScenarios();
  const results: BenchResult[] = [];

  for (const scenario of scenarios) {
    const frameworkOutcome = await scenario.runFramework(cloneTools(rawTools as RawToolMap) as any);
    const agentmintOutcome = await scenario.runAgentMint(
      await createBenchToolsFromSpec(cloneTools(rawTools as any), specYaml),
    );

    const details = [
      `framework=${frameworkOutcome.details}`,
      `agentmint=${agentmintOutcome.details}`,
    ].join(" | ");

    results.push({
      id: scenario.id,
      category: scenario.category,
      name: scenario.name,
      framework_catches: frameworkOutcome.caught,
      agentmint_catches: agentmintOutcome.caught,
      false_positive: !scenario.expectedAgentMintCatch && agentmintOutcome.caught,
      details,
      latency_us: agentmintOutcome.latency_us,
    });
  }

  const framework_caught = results.filter((result) => result.framework_catches).length;
  const agentmint_caught = results.filter((result) => result.agentmint_catches).length;
  const gaps = results.filter(
    (result) => !result.framework_catches && result.agentmint_catches,
  ).length;
  const false_positives = results.filter((result) => result.false_positive).length;
  const latency_us = results.find((result) => result.id === "L1")?.latency_us ?? 0;

  return {
    framework,
    timestamp: new Date().toISOString(),
    total: results.length,
    results,
    summary: {
      framework_caught,
      agentmint_caught,
      gaps,
      false_positives,
      latency_us,
    },
  };
}

export function formatBenchTable(report: BenchReport): string {
  const lines = [
    "| ID | Category | Scenario | Framework | AgentMint | FP? |",
    "|----|----------|----------|-----------|-----------|-----|",
  ];

  for (const result of report.results) {
    lines.push(
      `| ${result.id} | ${result.category} | ${result.name} | ${renderCatch(result.framework_catches)} | ${renderCatch(result.agentmint_catches)} | ${renderFalsePositive(result.false_positive)} |`,
    );
  }

  return lines.join("\n");
}

export function formatBenchMarkdown(report: BenchReport): string {
  return [
    `# Governance Benchmark: ${report.framework}`,
    "",
    `Generated: ${report.timestamp} by agentmint bench v0.2.0`,
    "",
    "## Summary",
    "| Metric | Count |",
    "|--------|-------|",
    `| Total scenarios | ${report.total} |`,
    `| Framework catches | ${report.summary.framework_caught} |`,
    `| AgentMint catches | ${report.summary.agentmint_caught} |`,
    `| Governance gaps | ${report.summary.gaps} |`,
    `| False positives | ${report.summary.false_positives} |`,
    `| Overhead | ${report.summary.latency_us}us/call |`,
    "",
    "## Results",
    formatBenchTable(report),
    "",
    "## How to reproduce",
    `npx @npmsai/agentmint bench --framework ${report.framework}`,
  ].join("\n");
}
