import { describe, expect, it } from "vitest";
import { AgentMintReport } from "./report.js";
import type { Event, RunState } from "./types.js";

const makeState = (overrides?: Partial<RunState>): RunState => ({
  runId: "amr_test1234",
  startedAt: Date.now(),
  status: "running",
  totalCost: 0,
  callCount: 0,
  executedCount: 0,
  blockedCount: 0,
  warnedCount: 0,
  heldCount: 0,
  killedCount: 0,
  skippedCount: 0,
  retryCounts: {},
  completedSteps: new Set(),
  boundValues: {},
  events: [],
  retrievedData: [],
  session: { inputs: new Map(), outputs: new Map(), callHistory: [] },
  ...overrides,
});

const makeEvent = (overrides?: Partial<Event>): Event => ({
  timestamp: new Date().toISOString(),
  elapsed: "0.0s",
  tool: "read_patient",
  params: {},
  result: "allowed",
  ...overrides,
});

describe("AgentMintReport", () => {
  it("empty_report", () => {
    const out = new AgentMintReport().generate();
    expect(out).toContain("0 total");
  });

  it("single_run", () => {
    const report = new AgentMintReport();
    report.addRun(makeState({ status: "completed" }));
    const out = report.generate();
    expect(out).toContain("1 total");
    expect(out).toContain("1 completed (100%)");
  });

  it("killed_counted", () => {
    const report = new AgentMintReport();
    report.addRun(makeState({ status: "completed" }));
    report.addRun(makeState({ status: "killed" }));
    const out = report.generate();
    expect(out).toContain("2 total");
    expect(out).toContain("1 killed (50%)");
  });

  it("time_filter", () => {
    const report = new AgentMintReport();
    report.addRun(makeState({ startedAt: Date.now() - 10 * 86_400_000 }));
    report.addRun(makeState({ startedAt: Date.now() }));
    const out = report.generate({ last: "7d" });
    expect(out).toContain("1 total");
  });

  it("json_format", () => {
    const report = new AgentMintReport();
    report.addRun(
      makeState({
        status: "completed",
        blockedCount: 2,
        events: [
          makeEvent({ result: "blocked", reason: "bind_violation" }),
          makeEvent({ result: "blocked", reason: "denied" }),
        ],
      }),
    );
    const parsed = JSON.parse(report.generate({ format: "json" }));
    expect(parsed.totalRuns).toBe(1);
    expect(parsed.completedRuns).toBe(1);
    expect(parsed.bindViolations).toBe(1);
    expect(parsed.denyBlocks).toBe(1);
  });

  it("text_format", () => {
    const report = new AgentMintReport();
    report.addRun(makeState({ status: "completed" }));
    const out = report.generate();
    expect(out).toContain("AgentMint Production Report");
    expect(out).toContain("RUNS");
    expect(out).toContain("COST");
  });
});
