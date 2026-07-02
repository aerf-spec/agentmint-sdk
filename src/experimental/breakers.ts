import type { SessionStore, SpecBreakerConfig, Violation } from "../types.js";
import { hashArgs } from "../session.js";

export function checkBreakers(
  tool: string,
  params: Record<string, unknown>,
  session: SessionStore,
  breakers: SpecBreakerConfig | undefined,
  totalCost: number,
): Violation[] {
  const violations: Violation[] = [];
  if (!breakers) return violations;

  // Loop breaker: count identical calls (same tool + same args)
  if (breakers.loop) {
    const hash = hashArgs(tool, params);
    let identicalCount = 0;
    for (const entry of session.callHistory) {
      if (entry.tool === tool && entry.argsHash === hash) {
        identicalCount++;
      }
    }
    if (identicalCount >= breakers.loop.max_identical_calls) {
      violations.push({
        type: "loop_breaker",
        tool,
        expected: String(breakers.loop.max_identical_calls),
        actual: String(identicalCount),
        details: `${tool} called ${identicalCount} times with identical args (limit: ${breakers.loop.max_identical_calls})`,
        action: breakers.loop.action ?? "block",
      });
    }
  }

  // Velocity breaker: total calls in time window
  if (breakers.velocity) {
    const windowMs = breakers.velocity.window_seconds * 1000;
    const cutoff = Date.now() - windowMs;
    const recentCalls = session.callHistory.filter((c) => c.timestamp >= cutoff).length;
    if (recentCalls >= breakers.velocity.max_calls_per_window) {
      violations.push({
        type: "velocity_breaker",
        tool,
        details: `${recentCalls} calls in last ${breakers.velocity.window_seconds}s (limit: ${breakers.velocity.max_calls_per_window})`,
        action: breakers.velocity.action ?? "block",
      });
    }
  }

  // Cost breaker
  if (breakers.cost && totalCost >= breakers.cost.max_usd) {
    violations.push({
      type: "cost_breaker",
      tool,
      details: `Total cost $${totalCost.toFixed(2)} exceeds limit $${breakers.cost.max_usd.toFixed(2)}`,
      action: breakers.cost.action ?? "block",
    });
  }

  return violations;
}
