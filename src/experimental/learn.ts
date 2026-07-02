import type {
  AgentMintSpec,
  JSONLEvent,
  RuleAction,
  SpecBreakerConfig,
  SpecPropertyConfig,
  SpecToolConfig,
} from "../types.js";

// ── Violation extraction ───────────────────────────────────────────
// A receipt event records a violation via its `reason` (the violation type)
// and `details` (a human-readable description we parse structured data back
// out of). Newer events may also carry a structured `violations[]` array.

type VioType =
  | "requires"
  | "cross_ref"
  | "max_ref"
  | "blocked_pattern"
  | "blocked_value"
  | "loop_breaker"
  | "velocity_breaker"
  | "cost_breaker"
  | "bind_violation"
  | "action_block";

const VIO_TYPES = new Set<string>([
  "requires",
  "cross_ref",
  "max_ref",
  "blocked_pattern",
  "blocked_value",
  "loop_breaker",
  "velocity_breaker",
  "cost_breaker",
  "bind_violation",
  "action_block",
]);

interface Descriptor {
  type: VioType;
  tool: string;
  action: RuleAction;
  field?: string;
  ref?: string;
  pattern?: string;
  value?: string;
  req?: string;
  limit?: number;
  windowSeconds?: number;
  maxUsd?: number;
}

function actionFromResult(result: string): RuleAction {
  return result === "warned" ? "warn" : "block";
}

/** Parse a single (type, details) pair into a structured descriptor. */
function parseDetails(
  type: VioType,
  tool: string,
  action: RuleAction,
  field: string | undefined,
  details: string | undefined,
): Descriptor | null {
  const d = details ?? "";
  const base = { type, tool, action } as Descriptor;

  switch (type) {
    case "requires": {
      const m = d.match(/"([^"]+)" must be called before/);
      if (!m) return null;
      return { ...base, req: m[1] };
    }
    case "cross_ref": {
      const f = field ?? d.match(/^([\w.]+):/)?.[1];
      const ref = d.match(/\(from ([^)]+)\)/)?.[1];
      if (!f || !ref) return null;
      return { ...base, field: f.replace(/^output\./, ""), ref };
    }
    case "max_ref": {
      const f = field ?? d.match(/^([\w.]+):/)?.[1];
      const ref = d.match(/\(from ([^)]+)\)/)?.[1];
      if (!f || !ref) return null;
      return { ...base, field: f, ref };
    }
    case "blocked_pattern": {
      const f = field ?? d.match(/^(\w+) contains blocked pattern/)?.[1];
      const pattern = d.match(/blocked pattern "([^"]*)"/)?.[1];
      if (!f || pattern === undefined) return null;
      return { ...base, field: f, pattern };
    }
    case "blocked_value": {
      const f = field ?? d.match(/^(\w+) has blocked value/)?.[1];
      const value = d.match(/blocked value "([^"]*)"/)?.[1];
      if (!f || value === undefined) return null;
      return { ...base, field: f, value };
    }
    case "loop_breaker": {
      const limit = d.match(/limit: (\d+)/)?.[1];
      return { ...base, limit: limit ? parseInt(limit, 10) : 3 };
    }
    case "velocity_breaker": {
      const window = d.match(/last (\d+)s/)?.[1];
      const limit = d.match(/limit: (\d+)/)?.[1];
      return {
        ...base,
        limit: limit ? parseInt(limit, 10) : 10,
        windowSeconds: window ? parseInt(window, 10) : 60,
      };
    }
    case "cost_breaker": {
      const usd = d.match(/limit \$([\d.]+)/)?.[1];
      return { ...base, maxUsd: usd ? parseFloat(usd) : 0 };
    }
    case "action_block":
      // A tool blocked outright by a bare spec `action: block` — no details to
      // parse; the rule is simply "this tool is denied".
      return { ...base };
    case "bind_violation":
      // Bind is a run-time config constraint, not a spec rule — noted but not
      // representable in AgentMintSpec, so it does not shape the inferred spec.
      return { ...base };
    default:
      return null;
  }
}

function descriptorsFor(event: JSONLEvent): Descriptor[] {
  const out: Descriptor[] = [];

  if (event.violations && event.violations.length > 0) {
    for (const v of event.violations) {
      if (!VIO_TYPES.has(v.type)) continue;
      const action: RuleAction = v.action === "warn" ? "warn" : "block";
      const desc = parseDetails(v.type as VioType, event.tool, action, v.field, v.details);
      if (desc) out.push(desc);
    }
    return out;
  }

  if (event.reason && VIO_TYPES.has(event.reason)) {
    const desc = parseDetails(
      event.reason as VioType,
      event.tool,
      actionFromResult(event.result),
      undefined,
      event.details,
    );
    if (desc) out.push(desc);
  }
  return out;
}

// ── Spec inference ─────────────────────────────────────────────────

function ensureTool(spec: AgentMintSpec, tool: string): SpecToolConfig {
  if (!spec.tools) spec.tools = {};
  if (!spec.tools[tool]) spec.tools[tool] = {};
  return spec.tools[tool]!;
}

function ensureProp(
  spec: AgentMintSpec,
  tool: string,
  field: string,
): SpecPropertyConfig {
  const t = ensureTool(spec, tool);
  if (!t.input) t.input = {};
  if (!t.input.properties) t.input.properties = {};
  if (!t.input.properties[field]) t.input.properties[field] = {};
  return t.input.properties[field]!;
}

function addUnique(list: string[] | undefined, value: string): string[] {
  const arr = list ?? [];
  if (!arr.includes(value)) arr.push(value);
  return arr;
}

export function inferSpec(events: JSONLEvent[]): AgentMintSpec {
  const spec: AgentMintSpec = { version: "1.0" };

  for (const event of events) {
    for (const desc of descriptorsFor(event)) {
      switch (desc.type) {
        case "requires": {
          if (!desc.req) break;
          const t = ensureTool(spec, desc.tool);
          t.requires = addUnique(t.requires, desc.req);
          if (desc.action === "warn") t.action = "warn";
          break;
        }
        case "cross_ref": {
          if (!desc.field || !desc.ref) break;
          const p = ensureProp(spec, desc.tool, desc.field);
          p.cross_ref = desc.ref;
          if (desc.action === "block") p.action = "block";
          break;
        }
        case "max_ref": {
          if (!desc.field || !desc.ref) break;
          const p = ensureProp(spec, desc.tool, desc.field);
          p.max_ref = desc.ref;
          if (desc.action === "block") p.action = "block";
          break;
        }
        case "blocked_pattern": {
          if (!desc.field || desc.pattern === undefined) break;
          const p = ensureProp(spec, desc.tool, desc.field);
          p.blocked_patterns = addUnique(p.blocked_patterns, desc.pattern);
          if (desc.action === "block") p.action = "block";
          break;
        }
        case "blocked_value": {
          if (!desc.field || desc.value === undefined) break;
          const p = ensureProp(spec, desc.tool, desc.field);
          p.blocked_values = addUnique(p.blocked_values, desc.value);
          if (desc.action === "block") p.action = "block";
          break;
        }
        case "loop_breaker": {
          if (!spec.breakers) spec.breakers = {};
          spec.breakers.loop = {
            max_identical_calls: desc.limit ?? 3,
            action: desc.action,
          };
          break;
        }
        case "velocity_breaker": {
          if (!spec.breakers) spec.breakers = {};
          spec.breakers.velocity = {
            max_calls_per_window: desc.limit ?? 10,
            window_seconds: desc.windowSeconds ?? 60,
            action: desc.action,
          };
          break;
        }
        case "cost_breaker": {
          if (!spec.breakers) spec.breakers = {};
          spec.breakers.cost = { max_usd: desc.maxUsd ?? 0, action: desc.action };
          break;
        }
        case "action_block": {
          const t = ensureTool(spec, desc.tool);
          t.action = "block";
          break;
        }
        case "bind_violation":
          break;
      }
    }
  }

  return spec;
}

/** True when an event records a policy violation that shapes the inferred spec. */
export function isViolation(event: JSONLEvent): boolean {
  return descriptorsFor(event).length > 0;
}

/** Count the distinct rules an inferred spec expresses (tools + breakers). */
export function countRules(spec: AgentMintSpec): number {
  let n = 0;
  for (const t of Object.values(spec.tools ?? {})) {
    if (t.action) n++;
    if (t.requires && t.requires.length > 0) n++;
    n += Object.keys(t.input?.properties ?? {}).length;
    n += Object.keys(t.output?.properties ?? {}).length;
  }
  const b = spec.breakers;
  if (b) n += (["loop", "velocity", "cost", "budget"] as const).filter((k) => b[k]).length;
  return n;
}

// ── Merge ──────────────────────────────────────────────────────────

/** Merge inferred rules into an existing spec, preserving existing rules. */
export function mergeSpecs(base: AgentMintSpec, add: AgentMintSpec): AgentMintSpec {
  const out: AgentMintSpec = {
    version: base.version || add.version || "1.0",
  };
  if (base.defaults || add.defaults) {
    out.defaults = { ...add.defaults, ...base.defaults };
  }

  const tools: Record<string, SpecToolConfig> = {};
  for (const [name, cfg] of Object.entries(add.tools ?? {})) {
    tools[name] = structuredCloneTool(cfg);
  }
  for (const [name, cfg] of Object.entries(base.tools ?? {})) {
    tools[name] = mergeTool(tools[name], cfg);
  }
  if (Object.keys(tools).length > 0) out.tools = tools;

  if (base.breakers || add.breakers) {
    out.breakers = { ...add.breakers, ...base.breakers } as SpecBreakerConfig;
  }
  return out;
}

function structuredCloneTool(cfg: SpecToolConfig): SpecToolConfig {
  return JSON.parse(JSON.stringify(cfg)) as SpecToolConfig;
}

function mergeTool(add: SpecToolConfig | undefined, base: SpecToolConfig): SpecToolConfig {
  const merged: SpecToolConfig = add ? structuredCloneTool(add) : {};
  if (base.action) merged.action = base.action;
  if (base.requires) {
    let requires = merged.requires ?? [];
    for (const r of base.requires) if (!requires.includes(r)) requires = [...requires, r];
    merged.requires = requires;
  }
  for (const dir of ["input", "output"] as const) {
    const baseDir = base[dir];
    if (!baseDir?.properties) continue;
    if (!merged[dir]) merged[dir] = {};
    if (!merged[dir]!.properties) merged[dir]!.properties = {};
    for (const [field, prop] of Object.entries(baseDir.properties)) {
      merged[dir]!.properties![field] = {
        ...merged[dir]!.properties![field],
        ...prop,
      };
    }
  }
  return merged;
}

// ── Serialization ──────────────────────────────────────────────────
// Emits a YAML subset that round-trips through spec.ts's parseYaml.

function q(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function scalar(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return q(String(value));
}

export function serializeSpec(spec: AgentMintSpec): string {
  const lines: string[] = [];
  lines.push(`version: ${q(String(spec.version ?? "1.0"))}`);

  if (spec.defaults?.action) {
    lines.push("defaults:");
    lines.push(`  action: ${spec.defaults.action}`);
  }

  if (spec.tools && Object.keys(spec.tools).length > 0) {
    lines.push("tools:");
    for (const [tool, cfg] of Object.entries(spec.tools)) {
      lines.push(`  ${tool}:`);
      if (cfg.action) lines.push(`    action: ${cfg.action}`);
      if (cfg.requires && cfg.requires.length > 0) {
        lines.push("    requires:");
        for (const r of cfg.requires) lines.push(`      - ${scalar(r)}`);
      }
      serializeProps(lines, "input", cfg.input?.properties);
      serializeProps(lines, "output", cfg.output?.properties);
    }
  }

  if (spec.breakers && Object.keys(spec.breakers).length > 0) {
    lines.push("breakers:");
    const b = spec.breakers;
    if (b.loop) {
      lines.push("  loop:");
      lines.push(`    max_identical_calls: ${b.loop.max_identical_calls}`);
      if (b.loop.action) lines.push(`    action: ${b.loop.action}`);
    }
    if (b.velocity) {
      lines.push("  velocity:");
      lines.push(`    max_calls_per_window: ${b.velocity.max_calls_per_window}`);
      lines.push(`    window_seconds: ${b.velocity.window_seconds}`);
      if (b.velocity.action) lines.push(`    action: ${b.velocity.action}`);
    }
    if (b.cost) {
      lines.push("  cost:");
      lines.push(`    max_usd: ${b.cost.max_usd}`);
      if (b.cost.action) lines.push(`    action: ${b.cost.action}`);
    }
  }

  return lines.join("\n") + "\n";
}

// ── Regression-test generation ─────────────────────────────────────
// From the same receipts we infer the spec, emit a self-contained vitest file
// that reloads the spec, replays the recorded call sequence through harden(),
// and asserts each blocked call is re-blocked (with its reason) and each allowed
// call still passes. The file is runnable as-is: `npx vitest run <file>`.

interface ReplayCall {
  tool: string;
  params: Record<string, unknown>;
  result: string;
  reason?: string;
}

/**
 * Seed values for stub outputs referenced by cross_ref/max_ref rules. For a rule
 * like `amount.max_ref: lookup_customer.output.balance`, the producing tool's
 * stub must return a `balance` that reproduces the violation on replay. We read
 * the exact figure back out of the recorded violation details.
 */
function outputSeeds(events: JSONLEvent[]): Record<string, Record<string, unknown>> {
  const seeds: Record<string, Record<string, unknown>> = {};
  const put = (tool: string, field: string, value: unknown) => {
    (seeds[tool] ??= {})[field] = value;
  };
  for (const e of events) {
    const d = e.details ?? "";
    if (e.reason === "max_ref") {
      const m = d.match(/exceeds max ([\d.]+) \(from ([\w.]+)\)/);
      if (m) {
        const [tool, kind, field] = m[2]!.split(".");
        if (kind === "output" && tool && field) put(tool, field, Number(m[1]));
      }
    } else if (e.reason === "cross_ref") {
      const m = d.match(/expected "([^"]*)" \(from ([\w.]+)\)/);
      if (m) {
        const [tool, kind, field] = m[2]!.split(".");
        if (kind === "output" && tool && field) put(tool, field, m[1]);
      }
    }
  }
  return seeds;
}

export function generateTestFile(opts: {
  events: JSONLEvent[];
  spec: AgentMintSpec;
  fromPath: string;
  testPath: string;
  timestamp: string;
  importSpecifier?: string;
}): string {
  const { events, spec, fromPath, testPath, timestamp } = opts;
  const importFrom = opts.importSpecifier ?? "@npmsai/agentmint";

  const calls: ReplayCall[] = events.map((e) => ({
    tool: e.tool,
    params: e.params ?? {},
    result: e.result,
    ...(e.result !== "allowed" && e.reason ? { reason: e.reason } : {}),
  }));

  const violations = events.filter(isViolation).length;
  const toolNames = [...new Set(events.map((e) => e.tool))];
  const seeds = outputSeeds(events);

  const stubLines = toolNames.map((name) => {
    const ret = seeds[name] ?? { ok: true };
    return `    ${JSON.stringify(name)}: async () => (${JSON.stringify(ret)}),`;
  });

  const yaml = serializeSpec(spec);

  return `// generated by: agentmint learn --from ${fromPath} --test ${testPath}
// source: ${events.length} events, ${violations} violations, ${timestamp}
// re-run the learn command to regenerate after policy changes
import { describe, it, expect } from "vitest";
import { harden, loadSpec } from ${JSON.stringify(importFrom)};

const SPEC = ${JSON.stringify(yaml)};

// The recorded call sequence, replayed in order so stateful rules (requires,
// cross_ref/max_ref, loop breakers) reproduce exactly.
const CALLS = ${JSON.stringify(calls, null, 2)};

// Stub tools. Return values don't matter for blocked calls (enforcement runs
// before execution); outputs referenced by cross_ref/max_ref rules are seeded
// so those rules re-fire on replay.
function makeTools() {
  return {
${stubLines.join("\n")}
  };
}

describe("learned policy regression (from ${fromPath})", () => {
${calls
  .map((c, i) =>
    c.result === "allowed"
      ? null
      : `  it(${JSON.stringify(
          `re-blocks ${c.tool} [${c.reason}] (call ${i + 1})`,
        )}, async () => {
    const tools = harden(makeTools(), { spec: loadSpec(SPEC), silent: true });
    let last;
    for (let k = 0; k <= ${i}; k++) {
      const call = CALLS[k];
      await (tools)[call.tool](call.params);
      const log = (tools).__log();
      last = log[log.length - 1];
    }
    expect(last.tool).toBe(${JSON.stringify(c.tool)});
    expect(last.result).toBe(${JSON.stringify(c.result)});
    expect(last.reason).toBe(${JSON.stringify(c.reason)});
  });`,
  )
  .filter(Boolean)
  .join("\n\n")}

  it("still allows every call the policy does not forbid", async () => {
    const tools = harden(makeTools(), { spec: loadSpec(SPEC), silent: true });
    const seen = [];
    for (const call of CALLS) {
      await (tools)[call.tool](call.params);
      const log = (tools).__log();
      seen.push(log[log.length - 1]);
    }
    CALLS.forEach((call, i) => {
      if (call.result === "allowed") expect(seen[i].result).toBe("allowed");
    });
  });
});
`;
}

function serializeProps(
  lines: string[],
  dir: "input" | "output",
  props: Record<string, SpecPropertyConfig> | undefined,
): void {
  if (!props || Object.keys(props).length === 0) return;
  lines.push(`    ${dir}:`);
  lines.push("      properties:");
  for (const [field, prop] of Object.entries(props)) {
    lines.push(`        ${field}:`);
    if (prop.cross_ref) lines.push(`          cross_ref: ${scalar(prop.cross_ref)}`);
    if (prop.max_ref) lines.push(`          max_ref: ${scalar(prop.max_ref)}`);
    if (prop.blocked_patterns && prop.blocked_patterns.length > 0) {
      lines.push("          blocked_patterns:");
      for (const p of prop.blocked_patterns) lines.push(`            - ${scalar(p)}`);
    }
    if (prop.blocked_values && prop.blocked_values.length > 0) {
      lines.push("          blocked_values:");
      for (const v of prop.blocked_values) lines.push(`            - ${scalar(v)}`);
    }
    if (prop.action) lines.push(`          action: ${prop.action}`);
  }
}
