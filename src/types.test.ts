import { describe, expect, it } from "vitest";
import type {
  AERFRecord,
  AgentMintConfig,
  BlockResponse,
  Event,
  JSONLEvent,
  MerkleProof,
  RuleAction,
  RunState,
  Violation,
} from "./types.js";

describe("types", () => {
  it("constructs a valid AgentMintConfig", () => {
    const config: AgentMintConfig = { bind: { patient_id: "PT-1" } };
    expect(config.bind?.patient_id).toBe("PT-1");
  });

  it("constructs a valid AgentMintConfig with spec", () => {
    const config: AgentMintConfig = {
      spec: { version: "1.0", tools: { foo: { requires: ["bar"] } } },
      onWarn: () => {},
    };
    expect(config.spec?.version).toBe("1.0");
  });

  it("constructs a valid RunState", () => {
    const state: RunState = {
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
    };
    expect(state.status).toBe("running");
    expect(state.warnedCount).toBe(0);
  });

  it("constructs a valid Event with warned result", () => {
    const event: Event = {
      timestamp: new Date().toISOString(),
      elapsed: "0.0s",
      tool: "test_tool",
      params: {},
      result: "warned",
      reason: "cross_ref",
    };
    expect(event.result).toBe("warned");
  });

  it("constructs a valid BlockResponse", () => {
    const block: BlockResponse = { error: true, tool: "x", message: "denied" };
    expect(block.error).toBe(true);
  });

  it("constructs a valid AERFRecord", () => {
    const record: AERFRecord = {
      version: "0.1.0",
      runId: "amr_test1234",
      boundValues: {},
      startedAt: new Date().toISOString(),
      status: "completed",
      mode: "enforce",
      events: [],
      summary: {
        calls: 0, executed: 0, blocked: 0, warned: 0,
        held: 0, skipped: 0, cost: null, budget: null, elapsedSeconds: 0,
      },
    };
    expect(record.version).toBe("0.1.0");
    expect(record.summary.warned).toBe(0);
  });

  it("constructs a valid MerkleProof", () => {
    const proof: MerkleProof = { leaf: "abc", index: 0, siblings: [], root: "def" };
    expect(proof.index).toBe(0);
  });

  it("constructs a valid Violation", () => {
    const v: Violation = {
      type: "cross_ref", tool: "refund", field: "order_id",
      details: "mismatch", action: "warn",
    };
    expect(v.action).toBe("warn");
  });

  it("constructs a valid JSONLEvent", () => {
    const e: JSONLEvent = {
      timestamp: new Date().toISOString(), runId: "amr_x",
      tool: "foo", result: "allowed",
    };
    expect(e.runId).toBe("amr_x");
  });

  it("RuleAction union", () => {
    const a: RuleAction = "block";
    const b: RuleAction = "warn";
    expect(a).toBe("block");
    expect(b).toBe("warn");
  });
});
