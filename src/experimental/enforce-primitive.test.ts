// The `enforce` core pipeline is exposed as a framework-agnostic primitive via
// the `@npmsai/agentmint/enforce` subpath, so a framework integration (the eve
// prior-auth example, say) can drive one RunState per session by hand:
// createRunState() once, then enforce() per tool call. These tests pin that
// usage — an allowed call, a spec-blocked call, and a receipt over both.
import { describe, expect, it } from "vitest";
import { enforce } from "./enforce.js";
import { createRunState } from "../log.js";
import { buildRecord } from "../receipt.js";
import { loadSpec } from "../kernel/spec.js";
import type { AgentMintConfig } from "../types.js";

const SPEC = `
version: "1.0"
tools:
  read_secret:
    action: block
`;

describe("enforce as a standalone per-run primitive", () => {
  it("runs an allowed call through and records it", async () => {
    const config: AgentMintConfig = { spec: loadSpec(SPEC) };
    const state = createRunState(config);

    const result = await enforce(
      "lookup",
      { id: "A1" },
      async () => ({ ok: true }),
      config,
      state,
    );

    expect(result).toEqual({ ok: true });
    expect(state.executedCount).toBe(1);
    const record = buildRecord(state, config);
    expect(record.events.map((e) => e.result)).toEqual(["allowed"]);
  });

  it("blocks a spec-blocked call and returns a BlockResponse without executing", async () => {
    const config: AgentMintConfig = { spec: loadSpec(SPEC) };
    const state = createRunState(config);
    let ran = false;

    const result = await enforce(
      "read_secret",
      { id: "A1" },
      async () => {
        ran = true;
        return "leaked";
      },
      config,
      state,
    );

    expect(ran).toBe(false);
    expect(result).toMatchObject({ error: true, tool: "read_secret" });
    expect(state.blockedCount).toBe(1);
  });

  it("threads a callRef through when meta.toolCallId is supplied", async () => {
    const config: AgentMintConfig = {};
    const state = createRunState(config);
    await enforce("t", {}, async () => "ok", config, state, { toolCallId: "call_9" });
    expect(state.events[0]?.callRef).toBe("call_9");
  });
});
