import type { AgentMintConfig, RunState, Violation } from "./types.js";
import { matchesAny } from "./matcher.js";
import { blockResponse, logEvent } from "./log.js";
import { recordInput, recordOutput } from "./session.js";
import { validateInputCrossRefs, validateOutputCrossRefs, checkRequires } from "./cross-ref.js";
import { checkBreakers } from "./breakers.js";
import { checkBudgetGuardrails, guardrailsActive, staticEstimate } from "./budget.js";

type BudgetContext = { estimate?: number; cumulative?: number; callIndex?: number };

function handleViolation(
  v: Violation,
  state: RunState,
  config: Readonly<AgentMintConfig>,
  params: Record<string, unknown>,
  shadow: boolean,
  extra: BudgetContext = {},
): { shouldBlock: boolean; response?: ReturnType<typeof blockResponse> } {
  if (v.action === "block") {
    state.blockedCount++;
    logEvent(state, v.tool, params, "blocked", { reason: v.type, details: v.details, ...extra });
    config.onBlock?.(v.tool, v.type, v.details);
    const resp = blockResponse(v.tool, v.details);
    return { shouldBlock: !shadow, response: resp };
  }
  // warn
  state.warnedCount++;
  logEvent(state, v.tool, params, "warned", { reason: v.type, details: v.details, ...extra });
  config.onWarn?.(v.tool, v.type, v.details);
  return { shouldBlock: false };
}

export async function enforce(
  tool: string,
  params: Record<string, unknown>,
  execute: () => Promise<unknown>,
  config: Readonly<AgentMintConfig>,
  state: RunState,
): Promise<unknown> {
  state.callCount++;
  const spec = config.spec;
  const shadow = config.mode === "shadow";

  // 0. Already dead
  if (state.status === "killed") {
    return blockResponse(tool, "Run has been terminated.");
  }

  // 1. Budget (existing programmatic config)
  if (
    config.budget !== undefined &&
    config.costEstimator &&
    state.totalCost >= config.budget
  ) {
    state.status = "killed";
    state.killReason = "budget_exceeded";
    state.killedCount++;
    logEvent(state, tool, params, "killed", {
      reason: "budget_exceeded",
      details: `$${state.totalCost.toFixed(2)} >= $${config.budget.toFixed(2)}`,
    });
    config.onKill?.("budget_exceeded", state);
    return blockResponse(tool, `Run budget of $${config.budget.toFixed(2)} exceeded.`);
  }

  // 2. Timeout
  if (config.timeout !== undefined) {
    const elapsed = (Date.now() - state.startedAt) / 1000;
    if (elapsed >= config.timeout) {
      state.status = "killed";
      state.killReason = "timeout";
      state.killedCount++;
      logEvent(state, tool, params, "killed", {
        reason: "timeout",
        details: `${elapsed.toFixed(1)}s >= ${config.timeout}s`,
      });
      config.onKill?.("timeout", state);
      return blockResponse(tool, `Run timeout of ${config.timeout}s exceeded.`);
    }
  }

  // 3. Record input to session (must happen before breaker check so current call is counted)
  recordInput(state.session, tool, params);

  // 4. Circuit breakers (spec-driven)
  if (spec?.breakers) {
    const breakerViolations = checkBreakers(
      tool, params, state.session, spec.breakers, state.totalCost,
    );
    for (const v of breakerViolations) {
      const result = handleViolation(v, state, config, params, shadow);
      if (result.shouldBlock) return result.response!;
    }
  }

  // 4. Retry limit
  if (config.retryLimit !== undefined) {
    const count = state.retryCounts[tool] ?? 0;
    if (count >= config.retryLimit) {
      state.skippedCount++;
      logEvent(state, tool, params, "skipped", {
        reason: "retry_limit",
        details: `${tool} called ${count} times, limit is ${config.retryLimit}`,
      });
      return blockResponse(
        tool,
        `${tool} has been called ${count} times (limit: ${config.retryLimit}). Try a different approach.`,
      );
    }
  }

  // 5. Bind
  if (config.bind) {
    for (const [field, expected] of Object.entries(config.bind)) {
      if (params[field] !== undefined && params[field] !== expected) {
        const details = `${field}: expected "${expected}", got "${String(params[field])}"`;
        state.blockedCount++;
        logEvent(state, tool, params, "blocked", { reason: "bind_violation", details });
        config.onBlock?.(tool, "bind_violation", details);
        const blocked = blockResponse(
          tool,
          `Access denied. ${field} must be "${expected}" for this run.`,
        );
        if (!shadow) return blocked;
        break;
      }
    }
  }

  // 6. Deny
  if (config.deny && matchesAny(tool, config.deny)) {
    state.blockedCount++;
    logEvent(state, tool, params, "blocked", { reason: "denied" });
    config.onBlock?.(tool, "denied");
    const blocked = blockResponse(tool, `${tool} is not available.`);
    if (!shadow) return blocked;
  }

  // 7. Allow
  if (config.allow && config.allow.length > 0 && !matchesAny(tool, config.allow)) {
    state.blockedCount++;
    logEvent(state, tool, params, "blocked", { reason: "not_in_scope" });
    config.onBlock?.(tool, "not_in_scope");
    const blocked = blockResponse(tool, `${tool} is not available.`);
    if (!shadow) return blocked;
  }

  // 7b. Spec: whole-tool action with no concrete rules (unconditional block/warn)
  //    A bare `action: block`/`action: warn` on a tool that declares no
  //    `requires` and no `input.properties` has no rule to attach to, so it
  //    applies to the tool as a whole. `block` denies the call outright; `warn`
  //    logs and proceeds. Tools that DO declare rules fall through to those
  //    rules below (where `action` still acts as the severity fallback).
  if (spec) {
    const toolSpec = spec.tools?.[tool];
    if (toolSpec?.action && !toolSpec.requires && !toolSpec.input?.properties) {
      if (toolSpec.action === "block") {
        state.blockedCount++;
        logEvent(state, tool, params, "blocked", { reason: "action_block" });
        config.onBlock?.(tool, "action_block");
        const blocked = blockResponse(
          tool,
          `${tool} is blocked by the spec (action: block).`,
        );
        if (!shadow) return blocked;
      } else {
        state.warnedCount++;
        logEvent(state, tool, params, "warned", { reason: "action_warn" });
        config.onWarn?.(tool, "action_warn");
      }
    }
  }

  // 8. Spec: requires
  if (spec) {
    const reqViolations = checkRequires(tool, spec, state.completedSteps);
    for (const v of reqViolations) {
      const result = handleViolation(v, state, config, params, shadow);
      if (result.shouldBlock) return result.response!;
    }
  }

  // 9. Programmatic requires (legacy)
  if (config.require && config.checkpoint && matchesAny(tool, config.checkpoint)) {
    for (const req of config.require) {
      if (!state.completedSteps.has(req)) {
        state.blockedCount++;
        logEvent(state, tool, params, "blocked", {
          reason: "prerequisite_missing",
          details: `"${req}" must be completed first`,
        });
        config.onBlock?.(tool, "prerequisite_missing", req);
        const blocked = blockResponse(
          tool,
          `Cannot execute ${tool}. Required step "${req}" has not been completed.`,
        );
        if (!shadow) return blocked;
        break;
      }
    }
  }

  // 10. Spec: cross-ref input validation + blocked patterns/values
  if (spec) {
    const inputViolations = validateInputCrossRefs(tool, params, spec, state.session);
    for (const v of inputViolations) {
      const result = handleViolation(v, state, config, params, shadow);
      if (result.shouldBlock) return result.response!;
    }
  }

  // 10b. Budget guardrails (pre-flight — the decision runs BEFORE execution,
  //      at the tool boundary, so an over-budget or capped call never spends).
  const budgetOn = guardrailsActive(config, spec);
  let budgetCtx: BudgetContext = {};
  if (budgetOn) {
    const decision = checkBudgetGuardrails(tool, params, spec, config, state);
    budgetCtx = {
      estimate: decision.estimate,
      cumulative: decision.cumulative,
      callIndex: decision.callIndex,
    };
    for (const v of decision.violations) {
      const result = handleViolation(v, state, config, params, shadow, budgetCtx);
      if (result.shouldBlock) return result.response!;
    }
  }

  // 11. Checkpoint
  if (config.checkpoint && matchesAny(tool, config.checkpoint)) {
    state.heldCount++;
    logEvent(state, tool, params, "held", { reason: "checkpoint_required" });
    if (config.gate) {
      const { gate } = await import("./gate.js");
      const result = await gate({
        action: tool,
        context: params,
        channel: config.gate.channel,
        ttl: config.gate.ttl,
        webhookUrl: config.gate.webhookUrl,
      });
      if (result.approved) {
        logEvent(state, tool, params, "approved", { reason: "gate_approved" });
      } else {
        state.blockedCount++;
        logEvent(state, tool, params, "rejected", {
          reason: "gate_rejected",
          details: result.reason,
        });
        config.onBlock?.(tool, "gate_rejected", result.reason);
        const blocked = blockResponse(
          tool,
          `${tool} was not approved${result.reason ? ` (${result.reason})` : ""}.`,
        );
        if (!shadow) return blocked;
      }
    } else if (config.onCheckpoint) {
      const approved = await config.onCheckpoint(tool, params);
      if (approved) {
        logEvent(state, tool, params, "approved", { reason: "checkpoint_approved" });
      } else {
        state.blockedCount++;
        logEvent(state, tool, params, "rejected", { reason: "checkpoint_rejected" });
        config.onBlock?.(tool, "checkpoint_rejected");
        const blocked = blockResponse(tool, `${tool} was not approved.`);
        if (!shadow) return blocked;
      }
    } else {
      config.onBlock?.(tool, "checkpoint_required");
      const blocked = blockResponse(
        tool,
        `${tool} requires approval. Provide an onCheckpoint callback.`,
      );
      if (!shadow) return blocked;
    }
  }

  // 12. Execute
  const t0 = Date.now();
  let result: unknown;
  try {
    result = await execute();
  } catch (err) {
    logEvent(state, tool, params, "allowed", {
      reason: "execution_error",
      details: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  const durationMs = Date.now() - t0;

  // Record output to session store AFTER execution
  recordOutput(state.session, tool, result);

  // 13. Spec: cross-ref output validation (warn only, post-execution)
  if (spec) {
    const outputViolations = validateOutputCrossRefs(tool, result, spec, state.session);
    for (const v of outputViolations) {
      // Output violations can only warn (tool already executed)
      state.warnedCount++;
      logEvent(state, tool, params, "warned", { reason: v.type, details: v.details });
      config.onWarn?.(tool, v.type, v.details);
    }
  }

  // 14. Cost accounting (post-execution actuals).
  //   - A dynamic costEstimator computes the actual cost from the real result
  //     (unchanged legacy behavior).
  //   - With no estimator but active budget guardrails, accumulate the tool's
  //     static YAML estimate so the per-run budget can track YAML-only setups.
  let cost: number | undefined;
  if (config.costEstimator) {
    cost = config.costEstimator(tool, params, result, state);
    state.totalCost += cost;
  } else if (budgetOn) {
    const est = staticEstimate(tool, spec);
    if (est !== undefined) {
      cost = est;
      state.totalCost += cost;
    }
  }

  // 15. Update state
  state.executedCount++;
  state.completedSteps.add(tool);
  state.retryCounts[tool] = (state.retryCounts[tool] ?? 0) + 1;
  if (result != null) {
    const summary =
      typeof result === "string"
        ? result.slice(0, 200)
        : JSON.stringify(result).slice(0, 200);
    state.retrievedData.push(`${tool}: ${summary}`);
  }

  // 16. Log — include the pre-flight estimate and the actual running total so
  //     receipts explain exactly what this call was projected and did cost.
  logEvent(state, tool, params, "allowed", {
    cost,
    durationMs,
    ...(budgetOn
      ? { estimate: budgetCtx.estimate, cumulative: state.totalCost, callIndex: budgetCtx.callIndex }
      : {}),
  });

  return result;
}
