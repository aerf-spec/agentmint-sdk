import type { AgentMintSpec, SessionStore, Violation } from "./types.js";
import { resolveRef } from "./session.js";
import { resolveAction } from "./spec.js";

/**
 * Match a value against a blocked pattern.
 *
 * If the pattern contains `*`, it is treated as a simple glob where `*`
 * matches any sequence of characters (including none) and the match is
 * anchored to the full string. Otherwise the pattern is a plain substring
 * check, preserving backward compatibility.
 *
 * An empty pattern or empty value never matches.
 */
export function matchPattern(value: string, pattern: string): boolean {
  if (pattern === "" || value === "") return false;
  if (!pattern.includes("*")) return value.includes(pattern);
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export function validateInputCrossRefs(
  tool: string,
  params: Record<string, unknown>,
  spec: AgentMintSpec,
  session: SessionStore,
): Violation[] {
  const violations: Violation[] = [];
  const toolSpec = spec.tools?.[tool];
  if (!toolSpec?.input?.properties) return violations;

  const globalDefault = spec.defaults?.action;

  for (const [field, propConfig] of Object.entries(toolSpec.input.properties)) {
    const value = params[field];
    const action = resolveAction(propConfig.action, toolSpec.action, globalDefault, "warn");

    // cross_ref: value must equal referenced value
    if (propConfig.cross_ref && value !== undefined) {
      const ref = resolveRef(session, propConfig.cross_ref);
      if (ref.found && ref.value !== value) {
        violations.push({
          type: "cross_ref",
          tool,
          field,
          expected: String(ref.value),
          actual: String(value),
          details: `${field}: expected "${String(ref.value)}" (from ${propConfig.cross_ref}), got "${String(value)}"`,
          action,
        });
      }
    }

    // max_ref: numeric value must be <= referenced value
    if (propConfig.max_ref && typeof value === "number") {
      const ref = resolveRef(session, propConfig.max_ref);
      if (ref.found && typeof ref.value === "number" && value > ref.value) {
        violations.push({
          type: "max_ref",
          tool,
          field,
          expected: String(ref.value),
          actual: String(value),
          details: `${field}: ${value} exceeds max ${ref.value} (from ${propConfig.max_ref})`,
          action,
        });
      }
    }

    // blocked_patterns: glob (with `*`) or substring match
    if (propConfig.blocked_patterns && typeof value === "string") {
      for (const pattern of propConfig.blocked_patterns) {
        if (matchPattern(value, pattern)) {
          violations.push({
            type: "blocked_pattern",
            tool,
            field,
            details: `${field} contains blocked pattern "${pattern}"`,
            action,
          });
          break;
        }
      }
    }

    // blocked_values: exact match
    if (propConfig.blocked_values && value !== undefined) {
      const strValue = String(value);
      if (propConfig.blocked_values.includes(strValue)) {
        violations.push({
          type: "blocked_value",
          tool,
          field,
          details: `${field} has blocked value "${strValue}"`,
          action,
        });
      }
    }
  }

  return violations;
}

export function validateOutputCrossRefs(
  tool: string,
  output: unknown,
  spec: AgentMintSpec,
  session: SessionStore,
): Violation[] {
  const violations: Violation[] = [];
  const toolSpec = spec.tools?.[tool];
  if (!toolSpec?.output?.properties || typeof output !== "object" || output === null)
    return violations;

  const globalDefault = spec.defaults?.action;
  const outputRecord = output as Record<string, unknown>;

  for (const [field, propConfig] of Object.entries(toolSpec.output.properties)) {
    const value = outputRecord[field];
    const action = resolveAction(propConfig.action, toolSpec.action, globalDefault, "warn");

    if (propConfig.cross_ref && value !== undefined) {
      let ref: { found: boolean; value: unknown };
      if (propConfig.cross_ref.startsWith("input.")) {
        const fieldName = propConfig.cross_ref.slice(6);
        const currentInput = session.inputs.get(tool);
        ref = currentInput
          ? { found: true, value: (currentInput)[fieldName] }
          : { found: false, value: undefined };
      } else {
        ref = resolveRef(session, propConfig.cross_ref);
      }

      if (ref.found && ref.value !== value) {
        violations.push({
          type: "cross_ref",
          tool,
          field,
          expected: String(ref.value),
          actual: String(value),
          details: `output.${field}: expected "${String(ref.value)}" (from ${propConfig.cross_ref}), got "${String(value)}"`,
          action,
        });
      }
    }
  }

  return violations;
}

export function checkRequires(
  tool: string,
  spec: AgentMintSpec,
  completedSteps: Set<string>,
): Violation[] {
  const violations: Violation[] = [];
  const toolSpec = spec.tools?.[tool];
  if (!toolSpec?.requires) return violations;

  const action = resolveAction(undefined, toolSpec.action, spec.defaults?.action, "block");

  for (const req of toolSpec.requires) {
    if (!completedSteps.has(req)) {
      violations.push({
        type: "requires",
        tool,
        details: `"${req}" must be called before "${tool}"`,
        action,
      });
    }
  }

  return violations;
}
