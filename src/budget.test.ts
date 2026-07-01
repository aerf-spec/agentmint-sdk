import { describe, expect, it } from "vitest";
import { harden } from "./harden.js";
import { loadSpec } from "./spec.js";
import { createRunState } from "./log.js";
import { formatJSONL } from "./jsonl.js";
import {
  checkBudgetGuardrails,
  estimateCallCost,
  resolveBudget,
  resolveCostCap,
  resolveUsageCap,
} from "./budget.js";
import type { AgentMintConfig, BlockResponse, RunState } from "./types.js";

const isBlock = (r: unknown): r is BlockResponse =>
  typeof r === "object" && r !== null && (r as BlockResponse).error === true;

function makeTools() {
  return {
    search_web: async (p: Record<string, unknown>) => ({ query: p.query, results: [] }),
    browser_screenshot: async (p: Record<string, unknown>) => ({ url: p.url, image: "png" }),
    cheap_tool: async () => ({ ok: true }),
  };
}

type Hardened = ReturnType<typeof makeTools> & { __state(): RunState; __receipt(): string };

// ── Pure functions ──────────────────────────────────────────────────

describe("estimate resolution", () => {
  const spec = loadSpec(`
version: "1.1"
tools:
  search_web:
    cost:
      estimate_usd: 0.03
`);

  it("uses the static YAML estimate when no dynamic estimator", () => {
    const state = createRunState({});
    expect(estimateCallCost("search_web", {}, spec, {}, state)).toBe(0.03);
  });

  it("dynamic estimator beats the static estimate", () => {
    const config: AgentMintConfig = { costEstimator: () => 0.5 };
    const state = createRunState(config);
    expect(estimateCallCost("search_web", {}, spec, config, state)).toBe(0.5);
  });

  it("falls back to 0 for an unknown tool with no estimate", () => {
    const state = createRunState({});
    expect(estimateCallCost("mystery", {}, spec, {}, state)).toBe(0);
  });
});

describe("override precedence (code beats YAML)", () => {
  const spec = loadSpec(`
version: "1.1"
tools:
  browser_screenshot:
    cost:
      estimate_usd: 0.08
      max_cost_usd: 0.10
    limits:
      max_calls_per_run: 2
breakers:
  budget:
    max_total_usd: 5.00
`);

  it("costCaps overrides YAML max_cost_usd", () => {
    const cap = resolveCostCap("browser_screenshot", spec, { costCaps: { browser_screenshot: 0.30 } });
    expect(cap.cap).toBe(0.30);
  });

  it("toolLimits overrides YAML max_calls_per_run", () => {
    const lim = resolveUsageCap("browser_screenshot", spec, { toolLimits: { browser_screenshot: { maxCallsPerRun: 9 } } });
    expect(lim.max).toBe(9);
  });

  it("code budget overrides YAML max_total_usd", () => {
    expect(resolveBudget(spec, { budget: 1.0 }).max).toBe(1.0);
    expect(resolveBudget(spec, {}).max).toBe(5.0);
  });
});

describe("checkBudgetGuardrails (pure)", () => {
  const spec = loadSpec(`
version: "1.1"
tools:
  browser_screenshot:
    cost:
      estimate_usd: 0.18
      max_cost_usd: 0.10
`);

  it("reports estimate, projection, and a legible cost_cap violation", () => {
    const state = createRunState({});
    const d = checkBudgetGuardrails("browser_screenshot", { url: "x" }, spec, {}, state);
    expect(d.estimate).toBe(0.18);
    expect(d.callIndex).toBe(1);
    expect(d.violations).toHaveLength(1);
    expect(d.violations[0]!.type).toBe("cost_cap");
    expect(d.violations[0]!.details).toBe(
      "browser_screenshot estimated $0.18 exceeds max_cost_usd $0.10",
    );
  });
});

// ── End-to-end through harden() ─────────────────────────────────────

describe("1. under cap — everything allowed", () => {
  it("allows calls that stay within every guardrail", async () => {
    const spec = loadSpec(`
version: "1.1"
tools:
  search_web:
    cost:
      estimate_usd: 0.03
      max_cost_usd: 0.05
    limits:
      max_calls_per_run: 3
breakers:
  budget:
    max_total_usd: 5.00
`);
    const tools = harden(makeTools(), { spec }) as Hardened;
    const r = await tools.search_web({ query: "a" });
    expect(isBlock(r)).toBe(false);
    expect(tools.__state().blockedCount).toBe(0);
    expect(tools.__state().totalCost).toBeCloseTo(0.03, 5);
  });
});

describe("2. over per-tool cap with warn", () => {
  it("warns but still executes", async () => {
    const spec = loadSpec(`
version: "1.1"
tools:
  browser_screenshot:
    cost:
      estimate_usd: 0.18
      max_cost_usd: 0.10
      action: warn
`);
    const warns: string[] = [];
    const tools = harden(makeTools(), { spec, onWarn: (_t, _r, d) => d && warns.push(d) }) as Hardened;
    const r = await tools.browser_screenshot({ url: "x" });
    expect(isBlock(r)).toBe(false);
    expect(tools.__state().warnedCount).toBe(1);
    expect(warns[0]).toContain("exceeds max_cost_usd $0.10");
  });
});

describe("3. over per-tool cap with block", () => {
  it("blocks before execution (default action)", async () => {
    const spec = loadSpec(`
version: "1.1"
tools:
  browser_screenshot:
    cost:
      estimate_usd: 0.18
      max_cost_usd: 0.10
`);
    const tools = harden(makeTools(), { spec }) as Hardened;
    const r = await tools.browser_screenshot({ url: "x" });
    expect(isBlock(r)).toBe(true);
    expect((r as unknown as BlockResponse).message).toContain("exceeds max_cost_usd $0.10");
    // Blocked pre-flight: never executed, nothing spent.
    expect(tools.__state().executedCount).toBe(0);
    expect(tools.__state().totalCost).toBe(0);
  });
});

describe("4. exceeding run total", () => {
  it("blocks the call that would push the run over budget", async () => {
    const spec = loadSpec(`
version: "1.1"
tools:
  search_web:
    cost:
      estimate_usd: 0.04
breakers:
  budget:
    max_total_usd: 0.10
`);
    const tools = harden(makeTools(), { spec }) as Hardened;
    expect(isBlock(await tools.search_web({ query: "1" }))).toBe(false); // 0.04
    expect(isBlock(await tools.search_web({ query: "2" }))).toBe(false); // 0.08
    const third = await tools.search_web({ query: "3" }); // 0.12 > 0.10
    expect(isBlock(third)).toBe(true);
    expect((third as unknown as BlockResponse).message).toContain("over budget $0.10");
    expect(tools.__state().totalCost).toBeCloseTo(0.08, 5);
  });
});

describe("5. exceeding max calls per tool", () => {
  it("blocks once the per-tool call cap is reached", async () => {
    const spec = loadSpec(`
version: "1.1"
tools:
  search_web:
    cost:
      estimate_usd: 0.01
    limits:
      max_calls_per_run: 2
`);
    const tools = harden(makeTools(), { spec }) as Hardened;
    expect(isBlock(await tools.search_web({ query: "1" }))).toBe(false);
    expect(isBlock(await tools.search_web({ query: "2" }))).toBe(false);
    const third = await tools.search_web({ query: "3" });
    expect(isBlock(third)).toBe(true);
    expect((third as unknown as BlockResponse).message).toContain("max_calls_per_run 2");
  });
});

describe("6. shadow mode does not block", () => {
  it("logs the violation but executes anyway", async () => {
    const spec = loadSpec(`
version: "1.1"
tools:
  browser_screenshot:
    cost:
      estimate_usd: 0.18
      max_cost_usd: 0.10
`);
    const tools = harden(makeTools(), { spec, mode: "shadow" }) as Hardened;
    const r = await tools.browser_screenshot({ url: "x" });
    expect(isBlock(r)).toBe(false);
    expect(tools.__state().executedCount).toBe(1);
    expect(tools.__state().events.some((e) => e.result === "blocked")).toBe(true);
  });
});

describe("7. YAML-only path", () => {
  it("tracks cost and enforces budget with no code config", async () => {
    const spec = loadSpec(`
version: "1.1"
tools:
  search_web:
    cost:
      estimate_usd: 0.03
breakers:
  budget:
    max_total_usd: 0.05
`);
    const tools = harden(makeTools(), { spec }) as Hardened;
    expect(isBlock(await tools.search_web({ query: "1" }))).toBe(false); // 0.03
    const second = await tools.search_web({ query: "2" }); // 0.06 > 0.05
    expect(isBlock(second)).toBe(true);
    expect(tools.__state().totalCost).toBeCloseTo(0.03, 5);
  });
});

describe("8. code-only path", () => {
  it("enforces caps and budget from code with no spec", async () => {
    const config: AgentMintConfig = {
      budget: 0.20,
      costCaps: { browser_screenshot: 0.10 },
      toolLimits: { search_web: { maxCallsPerRun: 1 } },
      costEstimator: (tool) => (tool === "browser_screenshot" ? 0.18 : 0.02),
    };
    const tools = harden(makeTools(), config) as Hardened;
    // browser_screenshot 0.18 > cap 0.10 → block
    expect(isBlock(await tools.browser_screenshot({ url: "x" }))).toBe(true);
    // search_web allowed once, blocked on the 2nd (maxCallsPerRun 1)
    expect(isBlock(await tools.search_web({ query: "1" }))).toBe(false);
    expect(isBlock(await tools.search_web({ query: "2" }))).toBe(true);
  });
});

describe("9. mixed path with precedence", () => {
  it("dynamic estimate + code cap both beat their YAML counterparts", async () => {
    const spec = loadSpec(`
version: "1.1"
tools:
  browser_screenshot:
    cost:
      estimate_usd: 0.08
      max_cost_usd: 0.10
`);
    const config: AgentMintConfig = {
      spec,
      // dynamic estimate (0.20) beats YAML estimate_usd (0.08)
      costEstimator: () => 0.20,
      // code cap (0.30) beats YAML max_cost_usd (0.10) → 0.20 < 0.30, allowed
      costCaps: { browser_screenshot: 0.30 },
    };
    const tools = harden(makeTools(), config) as Hardened;
    const r = await tools.browser_screenshot({ url: "x" });
    expect(isBlock(r)).toBe(false);
    expect(tools.__state().totalCost).toBeCloseTo(0.20, 5);
  });
});

describe("10. dynamic estimator path", () => {
  it("prices per-call from params, no static estimate needed", async () => {
    const config: AgentMintConfig = {
      costCaps: { browser_screenshot: 0.10 },
      costEstimator: (_tool, params) => (params.hd ? 0.18 : 0.05),
    };
    const tools = harden(makeTools(), config) as Hardened;
    expect(isBlock(await tools.browser_screenshot({ url: "x" }))).toBe(false); // 0.05
    expect(isBlock(await tools.browser_screenshot({ url: "x", hd: true }))).toBe(true); // 0.18 > 0.10
  });
});

describe("11. receipt output correctness", () => {
  it("shows estimate, cumulative cost, and the rule that fired", async () => {
    const spec = loadSpec(`
version: "1.1"
tools:
  search_web:
    cost:
      estimate_usd: 0.03
  browser_screenshot:
    cost:
      estimate_usd: 0.18
      max_cost_usd: 0.10
breakers:
  budget:
    max_total_usd: 5.00
`);
    const tools = harden(makeTools(), { spec }) as Hardened;
    await tools.search_web({ query: "a" });
    await tools.browser_screenshot({ url: "x" }); // blocked
    const receipt = tools.__receipt();
    expect(receipt).toContain("search_web");
    expect(receipt).toContain("browser_screenshot");
    expect(receipt).toContain("cost_cap");
    expect(receipt).toContain("estimated $0.18"); // the rule + values that fired
    // budget summary shows cost / budget
    expect(receipt).toContain("Cost: $0.03");
    expect(receipt).toContain("/ $5.00");
  });
});

describe("12. JSONL log correctness", () => {
  it("emits boring, grep/jq-friendly fields", async () => {
    const spec = loadSpec(`
version: "1.1"
tools:
  search_web:
    cost:
      estimate_usd: 0.03
breakers:
  budget:
    max_total_usd: 5.00
`);
    const tools = harden(makeTools(), { spec }) as Hardened;
    await tools.search_web({ query: "a" });
    const state = tools.__state();
    const jsonl = formatJSONL(state.events, state.runId);
    const parsed = JSON.parse(jsonl.split("\n").at(-1)!);
    expect(parsed.tool).toBe("search_web");
    expect(parsed.result).toBe("allowed");
    expect(parsed.estimate).toBe(0.03);
    expect(parsed.cumulative).toBeCloseTo(0.03, 5);
    expect(parsed.callIndex).toBe(1);
  });

  it("records the estimate and projection on a blocked budget event", async () => {
    const spec = loadSpec(`
version: "1.1"
tools:
  browser_screenshot:
    cost:
      estimate_usd: 0.18
      max_cost_usd: 0.10
`);
    const tools = harden(makeTools(), { spec }) as Hardened;
    await tools.browser_screenshot({ url: "x" });
    const state = tools.__state();
    const parsed = JSON.parse(formatJSONL(state.events, state.runId).split("\n").at(-1)!);
    expect(parsed.result).toBe("blocked");
    expect(parsed.reason).toBe("cost_cap");
    expect(parsed.estimate).toBe(0.18);
  });
});

describe("13. backward compatibility", () => {
  it("legacy costEstimator still accumulates actual cost post-hoc", async () => {
    const config: AgentMintConfig = { costEstimator: () => 1.5 };
    const tools = harden(makeTools(), config) as Hardened;
    await tools.cheap_tool();
    expect(tools.__state().totalCost).toBe(1.5);
  });

  it("legacy budget kill still fires", async () => {
    const config: AgentMintConfig = { budget: 5, costEstimator: () => 0 };
    const state = createRunState(config);
    state.totalCost = 10;
    const { enforce } = await import("./enforce.js");
    const r = await enforce("cheap_tool", {}, async () => ({ ok: true }), config, state);
    expect(isBlock(r)).toBe(true);
    expect(state.status).toBe("killed");
  });

  it("a spec with no budget guardrails behaves exactly as before", async () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  search_web:
    action: warn
`);
    const tools = harden(makeTools(), { spec }) as Hardened;
    const r = await tools.search_web({ query: "a" });
    expect(isBlock(r)).toBe(false);
    // no cost tracking when no guardrails are configured
    expect(tools.__receipt()).toContain("Calls:");
  });
});

describe("loud failure on misconfiguration", () => {
  it("throws when a cost cap has no estimate source", () => {
    const spec = loadSpec(`
version: "1.1"
tools:
  browser_screenshot:
    cost:
      max_cost_usd: 0.10
`);
    expect(() => harden(makeTools(), { spec })).toThrow(/no estimate/);
  });

  it("throws on a negative budget", () => {
    expect(() => harden(makeTools(), { budget: -1 })).toThrow(/non-negative/);
  });

  it("throws on a non-integer call cap", () => {
    expect(() =>
      harden(makeTools(), { toolLimits: { search_web: { maxCallsPerRun: 1.5 } } }),
    ).toThrow(/non-negative integer/);
  });

  it("throws on an invalid action", () => {
    const spec = loadSpec(`
version: "1.1"
tools:
  search_web:
    cost:
      estimate_usd: 0.03
      max_cost_usd: 0.05
      action: halt
`);
    expect(() => harden(makeTools(), { spec })).toThrow(/must be "warn" or "block"/);
  });
});

// ── Realistic scenario: a failed tool retries and silently burns cost ──

describe("realistic retry/loop scenario", () => {
  it("caps the cost of a search tool stuck in a retry loop", async () => {
    // The agent keeps re-calling search_web because it never gets a usable
    // answer. Without a guardrail this burns money indefinitely; the per-tool
    // usage cap stops it after 3 calls, and the run budget backstops it.
    const spec = loadSpec(`
version: "1.1"
tools:
  search_web:
    cost:
      estimate_usd: 0.03
    limits:
      max_calls_per_run: 3
breakers:
  budget:
    max_total_usd: 1.00
`);
    const tools = harden(makeTools(), { spec }) as Hardened;
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await tools.search_web({ query: "same failing query" }));
    }
    const blocked = results.filter(isBlock).length;
    const executed = results.length - blocked;
    expect(executed).toBe(3); // 3 allowed
    expect(blocked).toBe(3); // remaining 3 stopped by the usage cap
    expect(tools.__state().totalCost).toBeCloseTo(0.09, 5); // only paid for 3
  });
});
