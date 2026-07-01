// Budget Guardrails — pre-flight cost enforcement at the tool boundary.
//
// Every function here is pure and deterministic: given the same spec, config,
// and run state, it returns the same decision. Nothing here executes tools,
// mutates state, or reads the clock. `enforce()` owns the side effects.
//
// Precedence (highest first):
//   1. code override        (config.budget / costCaps / toolLimits / costEstimator)
//   2. YAML declaration      (breakers.budget / tools.<t>.cost / tools.<t>.limits)
// and, for the per-call estimate specifically:
//   dynamic estimator (costEstimator) beats static estimate (cost.estimate_usd).

import type {
  AgentMintConfig,
  AgentMintSpec,
  RuleAction,
  RunState,
  Violation,
} from "./types.js";

/** Hard caps default to blocking; a warn is opt-in via `action: warn`. */
const DEFAULT_ACTION: RuleAction = "block";

/** Static per-tool estimate declared in YAML (`tools.<t>.cost.estimate_usd`). */
export function staticEstimate(
  tool: string,
  spec: AgentMintSpec | undefined,
): number | undefined {
  const v = spec?.tools?.[tool]?.cost?.estimate_usd;
  return typeof v === "number" ? v : undefined;
}

/**
 * Estimated USD cost of one call, used for pre-flight decisions.
 * A dynamic `costEstimator` (called with `result: undefined`) beats the static
 * YAML estimate. Falls back to 0 when nothing is declared.
 */
export function estimateCallCost(
  tool: string,
  params: Record<string, unknown>,
  spec: AgentMintSpec | undefined,
  config: Readonly<AgentMintConfig>,
  state: RunState,
): number {
  if (config.costEstimator) {
    const dyn = config.costEstimator(tool, params, undefined, state);
    if (typeof dyn === "number" && Number.isFinite(dyn)) return dyn;
  }
  return staticEstimate(tool, spec) ?? 0;
}

/** Per-call hard cap. Code `costCaps[tool]` beats YAML `cost.max_cost_usd`. */
export function resolveCostCap(
  tool: string,
  spec: AgentMintSpec | undefined,
  config: Readonly<AgentMintConfig>,
): { cap: number | undefined; action: RuleAction } {
  const yamlCost = spec?.tools?.[tool]?.cost;
  const cap = config.costCaps?.[tool] ?? yamlCost?.max_cost_usd;
  return { cap, action: yamlCost?.action ?? DEFAULT_ACTION };
}

/** Per-tool usage cap. Code `toolLimits[tool]` beats YAML `limits.max_calls_per_run`. */
export function resolveUsageCap(
  tool: string,
  spec: AgentMintSpec | undefined,
  config: Readonly<AgentMintConfig>,
): { max: number | undefined; action: RuleAction } {
  const yamlLimits = spec?.tools?.[tool]?.limits;
  const max = config.toolLimits?.[tool]?.maxCallsPerRun ?? yamlLimits?.max_calls_per_run;
  return { max, action: yamlLimits?.action ?? DEFAULT_ACTION };
}

/** Per-run budget. Code `budget` beats YAML `breakers.budget.max_total_usd`. */
export function resolveBudget(
  spec: AgentMintSpec | undefined,
  config: Readonly<AgentMintConfig>,
): { max: number | undefined; action: RuleAction } {
  const yamlBudget = spec?.breakers?.budget;
  const max = config.budget ?? yamlBudget?.max_total_usd;
  return { max, action: yamlBudget?.action ?? DEFAULT_ACTION };
}

/** True when any budget-guardrail rule is configured (in code or YAML). */
export function guardrailsActive(
  config: Readonly<AgentMintConfig>,
  spec: AgentMintSpec | undefined,
): boolean {
  if (config.budget !== undefined) return true;
  if (config.costCaps && Object.keys(config.costCaps).length > 0) return true;
  if (config.toolLimits && Object.keys(config.toolLimits).length > 0) return true;
  if (spec?.breakers?.budget) return true;
  const tools = spec?.tools;
  if (tools) {
    for (const t of Object.values(tools)) {
      if (t.cost || t.limits) return true;
    }
  }
  return false;
}

export interface BudgetDecision {
  /** Estimated USD cost of this call. */
  estimate: number;
  /** Projected cumulative run cost if this call proceeds. */
  cumulative: number;
  /** 1-based index of this call among calls to the same tool this run. */
  callIndex: number;
  /** Rules that fired, most specific first (per-call, then usage, then budget). */
  violations: Violation[];
}

/**
 * Evaluate all budget guardrails for one prospective call, before it runs.
 * Returns the estimate/projection (for legible receipts) and any violations.
 */
export function checkBudgetGuardrails(
  tool: string,
  params: Record<string, unknown>,
  spec: AgentMintSpec | undefined,
  config: Readonly<AgentMintConfig>,
  state: RunState,
): BudgetDecision {
  const estimate = estimateCallCost(tool, params, spec, config, state);
  const priorCalls = state.retryCounts[tool] ?? 0;
  const callIndex = priorCalls + 1;
  const cumulative = round(state.totalCost + estimate);
  const violations: Violation[] = [];

  // 1. Per-call hard cap — this single call costs too much.
  const { cap, action: capAction } = resolveCostCap(tool, spec, config);
  if (cap !== undefined && estimate > cap) {
    violations.push({
      type: "cost_cap",
      tool,
      expected: cap.toFixed(2),
      actual: estimate.toFixed(2),
      details: `${tool} estimated $${estimate.toFixed(2)} exceeds max_cost_usd $${cap.toFixed(2)}`,
      action: capAction,
    });
  }

  // 2. Per-tool usage cap — this tool has been used too many times.
  const { max: maxCalls, action: limitAction } = resolveUsageCap(tool, spec, config);
  if (maxCalls !== undefined && priorCalls >= maxCalls) {
    violations.push({
      type: "usage_cap",
      tool,
      expected: String(maxCalls),
      actual: String(callIndex),
      details: `${tool} call ${callIndex} exceeds max_calls_per_run ${maxCalls}`,
      action: limitAction,
    });
  }

  // 3. Per-run budget — this call would push the run over its total budget.
  const { max: budget, action: budgetAction } = resolveBudget(spec, config);
  if (budget !== undefined && cumulative > budget) {
    violations.push({
      type: "budget_cap",
      tool,
      expected: budget.toFixed(2),
      actual: cumulative.toFixed(2),
      details: `${tool} would bring run to $${cumulative.toFixed(2)}, over budget $${budget.toFixed(2)} (est $${estimate.toFixed(2)} this call)`,
      action: budgetAction,
    });
  }

  return { estimate, cumulative, callIndex, violations };
}

// ── Validation (fail loudly at harden() time) ──────────────────────────

function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function assertAction(v: unknown, where: string): void {
  if (v !== undefined && v !== "warn" && v !== "block") {
    throw new Error(
      `agentmint budget: ${where} action must be "warn" or "block", got ${JSON.stringify(v)}.`,
    );
  }
}

/**
 * Validate budget-guardrail config up front so misconfiguration fails at setup,
 * not mid-run. Throws on negative/non-finite amounts, non-integer call caps,
 * bad actions, and caps that can never fire (a cost cap with no estimate source).
 */
export function validateGuardrails(
  config: Readonly<AgentMintConfig>,
  spec: AgentMintSpec | undefined,
): void {
  const { max: budget } = resolveBudget(spec, config);
  if (budget !== undefined && !isNonNegativeNumber(budget)) {
    throw new Error(`agentmint budget: run budget must be a non-negative number, got ${JSON.stringify(budget)}.`);
  }
  assertAction(spec?.breakers?.budget?.action, "breakers.budget");

  if (config.costCaps) {
    for (const [tool, cap] of Object.entries(config.costCaps)) {
      if (!isNonNegativeNumber(cap)) {
        throw new Error(`agentmint budget: costCaps["${tool}"] must be a non-negative number, got ${JSON.stringify(cap)}.`);
      }
    }
  }
  if (config.toolLimits) {
    for (const [tool, lim] of Object.entries(config.toolLimits)) {
      const m = lim?.maxCallsPerRun;
      if (m !== undefined && (!Number.isInteger(m) || m < 0)) {
        throw new Error(`agentmint budget: toolLimits["${tool}"].maxCallsPerRun must be a non-negative integer, got ${JSON.stringify(m)}.`);
      }
    }
  }

  const tools = spec?.tools;
  if (!tools) return;
  const hasDynamicEstimator = typeof config.costEstimator === "function";
  for (const [tool, t] of Object.entries(tools)) {
    if (t.cost) {
      const { estimate_usd, max_cost_usd } = t.cost;
      if (estimate_usd !== undefined && !isNonNegativeNumber(estimate_usd)) {
        throw new Error(`agentmint budget: tools.${tool}.cost.estimate_usd must be a non-negative number, got ${JSON.stringify(estimate_usd)}.`);
      }
      if (max_cost_usd !== undefined && !isNonNegativeNumber(max_cost_usd)) {
        throw new Error(`agentmint budget: tools.${tool}.cost.max_cost_usd must be a non-negative number, got ${JSON.stringify(max_cost_usd)}.`);
      }
      assertAction(t.cost.action, `tools.${tool}.cost`);
      // A per-call cap with no way to estimate cost can never fire — likely a mistake.
      const codeCap = config.costCaps?.[tool];
      if ((max_cost_usd !== undefined || codeCap !== undefined) &&
          estimate_usd === undefined && !hasDynamicEstimator) {
        throw new Error(
          `agentmint budget: tools.${tool} has a cost cap but no estimate. ` +
            `Add tools.${tool}.cost.estimate_usd or a costEstimator so the cap can be evaluated.`,
        );
      }
    }
    if (t.limits) {
      const m = t.limits.max_calls_per_run;
      if (m !== undefined && (!Number.isInteger(m) || m < 0)) {
        throw new Error(`agentmint budget: tools.${tool}.limits.max_calls_per_run must be a non-negative integer, got ${JSON.stringify(m)}.`);
      }
      assertAction(t.limits.action, `tools.${tool}.limits`);
    }
  }
}

/** Round to cents to keep cumulative arithmetic free of float drift. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
