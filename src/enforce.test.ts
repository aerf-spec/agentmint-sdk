import { describe, expect, it } from "vitest";
import { enforce } from "./enforce.js";
import { createRunState } from "./log.js";
import type { AgentMintConfig, AgentMintSpec, BlockResponse } from "./types.js";

const tool = async () => ({ ok: true });
const isBlock = (r: unknown): r is BlockResponse =>
  typeof r === "object" && r !== null && (r as BlockResponse).error === true;

describe("enforce", () => {
  it("budget_kill", async () => {
    const config: AgentMintConfig = { budget: 5, costEstimator: () => 0 };
    const state = createRunState(config);
    state.totalCost = 10;
    const result = await enforce("read", {}, tool, config, state);
    expect(isBlock(result)).toBe(true);
    expect(state.status).toBe("killed");
  });

  it("timeout_kill", async () => {
    const config: AgentMintConfig = { timeout: 300 };
    const state = createRunState(config);
    state.startedAt = Date.now() - 400_000;
    const result = await enforce("read", {}, tool, config, state);
    expect(isBlock(result)).toBe(true);
    expect(state.status).toBe("killed");
  });

  it("retry_skip", async () => {
    const config: AgentMintConfig = { retryLimit: 3 };
    const state = createRunState(config);
    state.retryCounts["read"] = 3;
    const result = await enforce("read", {}, tool, config, state);
    expect(isBlock(result)).toBe(true);
    expect(state.skippedCount).toBe(1);
  });

  it("bind_violation", async () => {
    const config: AgentMintConfig = { bind: { patient_id: "PT-4827" } };
    const state = createRunState(config);
    const result = await enforce(
      "read",
      { patient_id: "PT-9914" },
      tool,
      config,
      state,
    );
    expect(isBlock(result)).toBe(true);
    expect(state.blockedCount).toBe(1);
  });

  it("bind_correct", async () => {
    const config: AgentMintConfig = { bind: { patient_id: "PT-4827" } };
    const state = createRunState(config);
    const result = await enforce(
      "read",
      { patient_id: "PT-4827" },
      tool,
      config,
      state,
    );
    expect(result).toEqual({ ok: true });
  });

  it("bind_ignores_absent", async () => {
    const config: AgentMintConfig = { bind: { patient_id: "PT-4827" } };
    const state = createRunState(config);
    const result = await enforce("read", { plan_id: "X" }, tool, config, state);
    expect(result).toEqual({ ok: true });
  });

  it("deny_blocks", async () => {
    const config: AgentMintConfig = { deny: ["delete_*"] };
    const state = createRunState(config);
    const result = await enforce("delete_records", {}, tool, config, state);
    expect(isBlock(result)).toBe(true);
  });

  it("deny_exact", async () => {
    const config: AgentMintConfig = { deny: ["read_patient_sud"] };
    const state = createRunState(config);
    const result = await enforce("read_patient_sud", {}, tool, config, state);
    expect(isBlock(result)).toBe(true);
  });

  it("allow_blocks", async () => {
    const config: AgentMintConfig = { allow: ["read_*"] };
    const state = createRunState(config);
    const result = await enforce("delete_records", {}, tool, config, state);
    expect(isBlock(result)).toBe(true);
  });

  it("allow_passes", async () => {
    const config: AgentMintConfig = { allow: ["read_*"] };
    const state = createRunState(config);
    const result = await enforce("read_patient", {}, tool, config, state);
    expect(result).toEqual({ ok: true });
  });

  it("allow_empty", async () => {
    const config: AgentMintConfig = { allow: [] };
    const state = createRunState(config);
    const result = await enforce("delete_records", {}, tool, config, state);
    expect(result).toEqual({ ok: true });
  });

  it("deny_over_allow", async () => {
    const config: AgentMintConfig = { allow: ["delete_*"], deny: ["delete_*"] };
    const state = createRunState(config);
    const result = await enforce("delete_records", {}, tool, config, state);
    expect(isBlock(result)).toBe(true);
  });

  it("require_blocks", async () => {
    const config: AgentMintConfig = {
      require: ["step_a"],
      checkpoint: ["submit"],
    };
    const state = createRunState(config);
    const result = await enforce("submit", {}, tool, config, state);
    expect(isBlock(result)).toBe(true);
    expect((result as BlockResponse).message).toContain("step_a");
  });

  it("require_passes", async () => {
    const config: AgentMintConfig = {
      require: ["step_a"],
      checkpoint: ["submit"],
      onCheckpoint: async () => true,
    };
    const state = createRunState(config);
    state.completedSteps.add("step_a");
    const result = await enforce("submit", {}, tool, config, state);
    expect(result).toEqual({ ok: true });
  });

  it("checkpoint_approved", async () => {
    const config: AgentMintConfig = {
      checkpoint: ["submit"],
      onCheckpoint: async () => true,
    };
    const state = createRunState(config);
    const result = await enforce("submit", {}, tool, config, state);
    expect(result).toEqual({ ok: true });
  });

  it("checkpoint_rejected", async () => {
    const config: AgentMintConfig = {
      checkpoint: ["submit"],
      onCheckpoint: async () => false,
    };
    const state = createRunState(config);
    const result = await enforce("submit", {}, tool, config, state);
    expect(isBlock(result)).toBe(true);
    expect(state.blockedCount).toBe(1);
  });

  it("checkpoint_no_callback", async () => {
    const config: AgentMintConfig = { checkpoint: ["submit"] };
    const state = createRunState(config);
    const result = await enforce("submit", {}, tool, config, state);
    expect(isBlock(result)).toBe(true);
    expect(state.heldCount).toBe(1);
  });

  it("execute_success", async () => {
    const config: AgentMintConfig = {};
    const state = createRunState(config);
    const result = await enforce("read", {}, tool, config, state);
    expect(result).toEqual({ ok: true });
    expect(state.executedCount).toBe(1);
  });

  it("execute_error", async () => {
    const config: AgentMintConfig = {};
    const state = createRunState(config);
    const boom = async () => {
      throw new Error("boom");
    };
    await expect(enforce("read", {}, boom, config, state)).rejects.toThrow("boom");
    expect(state.events.at(-1)?.reason).toBe("execution_error");
  });

  it("cost_tracked", async () => {
    const config: AgentMintConfig = { costEstimator: () => 1.5 };
    const state = createRunState(config);
    await enforce("read", {}, tool, config, state);
    expect(state.totalCost).toBe(1.5);
  });

  it("killed_blocks_all", async () => {
    const config: AgentMintConfig = {};
    const state = createRunState(config);
    state.status = "killed";
    const result = await enforce("read", {}, tool, config, state);
    expect(isBlock(result)).toBe(true);
  });

  it("pipeline_order", async () => {
    const config: AgentMintConfig = { allow: ["delete_*"], deny: ["delete_*"] };
    const state = createRunState(config);
    const result = await enforce("delete_records", {}, tool, config, state);
    expect(isBlock(result)).toBe(true);
    expect(state.events.at(-1)?.reason).toBe("denied");
  });

  it("bare_action_block_denies_tool", async () => {
    const spec: AgentMintSpec = {
      version: "1.0",
      tools: { delete_account: { action: "block" } },
    };
    const config: AgentMintConfig = { spec };
    const state = createRunState(config);
    const result = await enforce("delete_account", {}, tool, config, state);
    expect(isBlock(result)).toBe(true);
    expect(state.blockedCount).toBe(1);
    expect(state.executedCount).toBe(0);
  });

  it("bare_action_warn_executes", async () => {
    const spec: AgentMintSpec = {
      version: "1.0",
      tools: { read_env: { action: "warn" } },
    };
    let warned = false;
    const config: AgentMintConfig = { spec, onWarn: () => (warned = true) };
    const state = createRunState(config);
    const result = await enforce("read_env", {}, tool, config, state);
    expect(result).toEqual({ ok: true });
    expect(state.warnedCount).toBe(1);
    expect(state.executedCount).toBe(1);
    expect(warned).toBe(true);
  });

  it("action_block_with_requires_lets_requires_fire_first", async () => {
    const spec: AgentMintSpec = {
      version: "1.0",
      tools: { issue_refund: { action: "block", requires: ["lookup_order"] } },
    };
    const config: AgentMintConfig = { spec };
    const state = createRunState(config);
    const result = await enforce("issue_refund", {}, tool, config, state);
    expect(isBlock(result)).toBe(true);
    expect(state.events.at(-1)?.reason).toBe("requires");
  });

  it("no_action_no_rules_executes", async () => {
    const spec: AgentMintSpec = {
      version: "1.0",
      tools: { read_env: {} },
    };
    const config: AgentMintConfig = { spec };
    const state = createRunState(config);
    const result = await enforce("read_env", {}, tool, config, state);
    expect(result).toEqual({ ok: true });
    expect(state.executedCount).toBe(1);
  });

  it("tool_not_in_spec_executes", async () => {
    const spec: AgentMintSpec = {
      version: "1.0",
      tools: { other_tool: { action: "block" } },
    };
    const config: AgentMintConfig = { spec };
    const state = createRunState(config);
    const result = await enforce("read_env", {}, tool, config, state);
    expect(result).toEqual({ ok: true });
    expect(state.executedCount).toBe(1);
  });

  it("shadow_mode", async () => {
    const config: AgentMintConfig = { mode: "shadow", deny: ["delete_*"] };
    const state = createRunState(config);
    const result = await enforce("delete_records", {}, tool, config, state);
    expect(result).toEqual({ ok: true });
    expect(state.events.some((e) => e.result === "blocked")).toBe(true);
    expect(state.executedCount).toBe(1);
  });
});
