import type {
  AERFRecord,
  AgentMintConfig,
  EventResult,
  RunState,
} from "./types.js";
import { guardrailsActive, resolveBudget } from "./kernel/budget.js";

const ICONS: Record<EventResult, string> = {
  allowed: "✓",
  warned: "⚠",
  blocked: "✗",
  held: "⏸",
  approved: "✓",
  rejected: "✗",
  killed: "⊘",
  skipped: "↷",
  attempted_after_kill: "⊘",
};

const SUFFIXES: Record<EventResult, string> = {
  blocked: "  BLOCKED",
  warned: "  WARNED",
  held: "  HELD",
  rejected: "  REJECTED",
  killed: "  KILLED",
  skipped: "  skipped",
  approved: "  approved",
  allowed: "",
  attempted_after_kill: "  AFTER-KILL",
};

const INNER_WIDTH = 64;

function truncate(line: string, width: number): string {
  if (line.length <= width) return line;
  if (width <= 1) return "…".slice(0, width);
  return `${line.slice(0, width - 1)}…`;
}

function pad(line: string, width: number): string {
  return `║${truncate(line, width).padEnd(width, " ")}║`;
}

export function buildRecord(
  state: RunState,
  config: Readonly<AgentMintConfig>,
): AERFRecord {
  return {
    version: "0.1.0",
    runId: state.runId,
    boundValues: { ...state.boundValues },
    startedAt: new Date(state.startedAt).toISOString(),
    status: state.status,
    mode: config.mode ?? "enforce",
    events: state.events.map((event) => {
      const boundParams: Record<string, string> = {};
      for (const key of Object.keys(event.params)) {
        if (!(key in state.boundValues)) continue;
        const value = event.params[key];
        if (typeof value === "string") {
          boundParams[key] = value;
        } else {
          boundParams[key] = state.boundValues[key]!;
        }
      }
      return {
        tool: event.tool,
        result: event.result,
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
        ...(event.details !== undefined ? { details: event.details } : {}),
        ...(Object.keys(boundParams).length > 0 ? { boundParams } : {}),
      };
    }),
    summary: {
      calls: state.callCount,
      executed: state.executedCount,
      blocked: state.blockedCount,
      warned: state.warnedCount,
      held: state.heldCount,
      skipped: state.skippedCount,
      cost:
        config.costEstimator || guardrailsActive(config, config.spec)
          ? state.totalCost
          : null,
      budget: resolveBudget(config.spec, config).max ?? null,
      elapsedSeconds: parseFloat(((Date.now() - state.startedAt) / 1000).toFixed(1)),
    },
    ...(config.require
      ? {
          requiredSteps: config.require.map((tool) => ({
            tool,
            completed: state.completedSteps.has(tool),
          })),
        }
      : {}),
    ...(state.evidence ? { evidenceRoot: state.evidence.build() } : {}),
  };
}

export function formatReceipt(
  state: RunState,
  config: Readonly<AgentMintConfig>,
): string {
  const record = buildRecord(state, config);
  const lines: string[] = [];

  lines.push(`╔${"═".repeat(INNER_WIDTH)}╗`);
  lines.push(
    pad(
      record.mode === "shadow"
        ? "  AgentMint Receipt  SHADOW MODE"
        : "  AgentMint Receipt",
      INNER_WIDTH,
    ),
  );
  lines.push(pad(`  Run: ${record.runId}`, INNER_WIDTH));
  if (record.mode === "shadow") {
    lines.push(pad("  Shadow decisions are logged but not enforced", INNER_WIDTH));
  }
  const boundKeys = Object.keys(record.boundValues);
  if (boundKeys.length > 0) {
    const bound = boundKeys
      .map((key) => `${key}: ${record.boundValues[key]}`)
      .join(" · ");
    lines.push(pad(`  ${bound}`, INNER_WIDTH));
  }
  lines.push(`╠${"═".repeat(INNER_WIDTH)}╣`);

  for (const event of record.events) {
    lines.push(
      pad(`  ${ICONS[event.result]} ${event.tool}${SUFFIXES[event.result]}`, INNER_WIDTH),
    );
    if (event.reason) {
      const detail = event.details ? `: ${event.details}` : "";
      lines.push(pad(`    ↳ ${event.reason}${detail}`, INNER_WIDTH));
    }
  }

  lines.push(pad("", INNER_WIDTH));

  let summary =
    record.summary.cost === null
      ? `Calls: ${record.summary.calls}`
      : `Cost: $${record.summary.cost.toFixed(2)}`;
  if (record.summary.cost !== null && record.summary.budget !== null) {
    summary += ` / $${record.summary.budget.toFixed(2)}`;
  }
  summary += ` · Blocked: ${record.summary.blocked}`;
  if (record.summary.warned > 0) {
    summary += ` · Warned: ${record.summary.warned}`;
  }
  lines.push(pad(`  ${summary}`, INNER_WIDTH));

  if (record.requiredSteps && record.requiredSteps.length > 0) {
    const required = record.requiredSteps
      .map((step) => `${step.completed ? "✓" : "✗"} ${step.tool}`)
      .join(" ");
    lines.push(pad(`  Required: ${required}`, INNER_WIDTH));
  }

  if (record.evidenceRoot) {
    lines.push(pad(`  Evidence: ${record.evidenceRoot.slice(0, 16)}…`, INNER_WIDTH));
  }

  lines.push(pad("", INNER_WIDTH));
  lines.push(`╚${"═".repeat(INNER_WIDTH)}╝`);

  return lines.join("\n");
}
