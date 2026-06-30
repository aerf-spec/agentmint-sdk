import { describe, expect, it } from "vitest";
import { buildRecord, formatReceipt } from "./receipt.js";
import type { AgentMintConfig, Event, RunState } from "./types.js";

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

describe("formatReceipt", () => {
  it("contains_header", () => {
    expect(formatReceipt(makeState(), {})).toContain("AgentMint Receipt");
  });

  it("contains_run_id", () => {
    expect(formatReceipt(makeState({ runId: "amr_abcd1234" }), {})).toContain(
      "amr_abcd1234",
    );
  });

  it("shows_events", () => {
    const state = makeState({
      events: [makeEvent({ tool: "fetch_record", result: "allowed" })],
    });
    expect(formatReceipt(state, {})).toContain("fetch_record");
  });

  it("shows_blocked_reason", () => {
    const state = makeState({
      events: [
        makeEvent({
          tool: "delete_patient",
          result: "blocked",
          reason: "denied",
        }),
      ],
    });
    const out = formatReceipt(state, {});
    expect(out).toContain("BLOCKED");
    expect(out).toContain("denied");
  });

  it("shows_cost", () => {
    const config: AgentMintConfig = { costEstimator: () => 0.5 };
    const state = makeState({ totalCost: 1.25 });
    expect(formatReceipt(state, config)).toContain("Cost: $1.25");
  });

  it("shows_required", () => {
    const config: AgentMintConfig = { require: ["verify_identity"] };
    const state = makeState({ completedSteps: new Set(["verify_identity"]) });
    const out = formatReceipt(state, config);
    expect(out).toContain("Required:");
    expect(out).toContain("verify_identity");
  });

  it("box_drawing", () => {
    const out = formatReceipt(makeState(), {});
    const lines = out.split("\n");
    expect(lines[0]?.startsWith("╔")).toBe(true);
    expect(lines[lines.length - 1]?.startsWith("╚")).toBe(true);
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
  });

  it("zero_events_uses_calls_summary", () => {
    const out = formatReceipt(makeState({ callCount: 2 }), {});
    expect(out).toContain("Calls: 2");
    expect(out).not.toContain("Cost:");
  });

  it("truncates_long_event_content", () => {
    const state = makeState({
      events: [
        makeEvent({
          tool: "this_is_a_very_long_tool_name_that_should_not_overflow_the_receipt_box",
          result: "blocked",
          reason: "reason_" + "x".repeat(80),
          details: "details_" + "y".repeat(80),
        }),
      ],
    });
    const lines = formatReceipt(state, {}).split("\n");
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
    expect(lines.some((line) => line.includes("…"))).toBe(true);
  });

  it("omits_empty_optional_lines", () => {
    const out = formatReceipt(makeState(), {});
    expect(out).not.toContain("patient_id:");
    expect(out).not.toContain("Required:");
  });

  it("aerf_record_shape", () => {
    const config: AgentMintConfig = {
      mode: "enforce",
      budget: 10,
      require: ["verify_identity"],
    };
    const state = makeState({
      runId: "amr_rec00001",
      status: "completed",
      callCount: 3,
      executedCount: 2,
      blockedCount: 1,
      boundValues: { patient_id: "PT-1" },
      completedSteps: new Set(["verify_identity"]),
      events: [
        makeEvent({
          tool: "read_patient",
          result: "allowed",
          params: { patient_id: "PT-1" },
        }),
      ],
    });
    const record = buildRecord(state, config);
    expect(record.version).toBe("0.1.0");
    expect(record.runId).toBe("amr_rec00001");
    expect(record.mode).toBe("enforce");
    expect(record.status).toBe("completed");
    expect(record.summary.calls).toBe(3);
    expect(record.summary.blocked).toBe(1);
    expect(record.summary.warned).toBe(0);
    expect(record.summary.budget).toBe(10);
    expect(record.events[0]?.boundParams).toEqual({ patient_id: "PT-1" });
    expect(record.requiredSteps).toEqual([
      { tool: "verify_identity", completed: true },
    ]);
  });

  it("aerf_record_cost_null_without_estimator", () => {
    const record = buildRecord(makeState({ totalCost: 12.5 }), {});
    expect(record.summary.cost).toBeNull();
  });
});
