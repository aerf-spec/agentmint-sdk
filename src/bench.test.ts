import { describe, expect, it } from "vitest";
import { formatBenchMarkdown, runBench } from "./bench.js";
import { DEMO_SPEC_YAML, createDemoTools } from "./bench-scenarios.js";

describe("bench", () => {
  it("runBench produces a valid BenchReport", async () => {
    const report = await runBench("demo", createDemoTools(), DEMO_SPEC_YAML);
    expect(report.framework).toBe("demo");
    expect(report.total).toBe(20);
    expect(report.results).toHaveLength(20);
    expect(report.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("formatBenchMarkdown produces shareable markdown", async () => {
    const report = await runBench("demo", createDemoTools(), DEMO_SPEC_YAML);
    const markdown = formatBenchMarkdown(report);
    expect(markdown).toContain("# Governance Benchmark: demo");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("## Results");
    expect(markdown).toContain("agentmint bench --framework demo");
  });

  it("all built-in scenarios run without error", async () => {
    const report = await runBench("demo", createDemoTools(), DEMO_SPEC_YAML);
    expect(report.results.map((result) => result.id)).toEqual([
      "P1",
      "P2",
      "P3",
      "P4",
      "P5",
      "E1",
      "E2",
      "E3",
      "E4",
      "E5",
      "E6",
      "A1",
      "A2",
      "A3",
      "B1",
      "B2",
      "B3",
      "C1",
      "C2",
      "L1",
    ]);
  });

  it("clean scenarios produce zero false positives", async () => {
    const report = await runBench("demo", createDemoTools(), DEMO_SPEC_YAML);
    const cleanResults = report.results.filter((result) => result.category === "clean");
    expect(cleanResults).toHaveLength(2);
    expect(cleanResults.every((result) => result.false_positive === false)).toBe(true);
    expect(cleanResults.every((result) => result.agentmint_catches === false)).toBe(true);
  });

  it("latency scenario produces a number greater than zero", async () => {
    const report = await runBench("demo", createDemoTools(), DEMO_SPEC_YAML);
    const latency = report.results.find((result) => result.id === "L1");
    expect(latency?.latency_us).toBeGreaterThan(0);
  });
});
