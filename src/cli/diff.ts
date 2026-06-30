import { existsSync, readFileSync } from "node:fs";
import { parseJSONL } from "../jsonl.js";
import type { JSONLEvent } from "../types.js";
import { brand, dim, fg, green, muted, red, yellow } from "./color.js";

function violationKey(e: JSONLEvent): string {
  return `${e.tool}::${e.reason ?? "unknown"}`;
}

function extractViolations(events: JSONLEvent[]): Map<string, JSONLEvent> {
  const map = new Map<string, JSONLEvent>();
  for (const e of events) {
    if (e.result === "blocked" || e.result === "warned" || e.result === "killed") {
      const key = violationKey(e);
      if (!map.has(key)) map.set(key, e);
    }
  }
  return map;
}

function countToolCalls(events: JSONLEvent[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of events) {
    map.set(e.tool, (map.get(e.tool) ?? 0) + 1);
  }
  return map;
}

export async function runDiff(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.length < 2) {
    console.log("");
    console.log(`  ${brand()} ${fg("diff")}`);
    console.log("");
    console.log(`  ${muted("Usage:")} agentmint diff ${dim("<receipt1.jsonl> <receipt2.jsonl>")}`);
    console.log(`  ${muted("Compare behavior between two agent runs.")}`);
    console.log("");
    return;
  }

  const [file1, file2] = args as [string, string];

  for (const f of [file1, file2]) {
    if (!existsSync(f)) {
      console.error(`\n  ${red("✗")} File not found: ${red(f)}\n`);
      process.exitCode = 1;
      return;
    }
  }

  const events1 = parseJSONL(readFileSync(file1, "utf-8"));
  const events2 = parseJSONL(readFileSync(file2, "utf-8"));

  const v1 = extractViolations(events1);
  const v2 = extractViolations(events2);
  const calls1 = countToolCalls(events1);
  const calls2 = countToolCalls(events2);

  const newViolations: JSONLEvent[] = [];
  const resolvedViolations: JSONLEvent[] = [];
  const changedCalls: Array<{ tool: string; before: number; after: number }> = [];

  // New violations (in run 2 but not run 1)
  for (const [key, event] of v2) {
    if (!v1.has(key)) newViolations.push(event);
  }

  // Resolved violations (in run 1 but not run 2)
  for (const [key, event] of v1) {
    if (!v2.has(key)) resolvedViolations.push(event);
  }

  // Changed call counts
  const allTools = new Set([...calls1.keys(), ...calls2.keys()]);
  for (const tool of allTools) {
    const before = calls1.get(tool) ?? 0;
    const after = calls2.get(tool) ?? 0;
    if (before !== after) {
      changedCalls.push({ tool, before, after });
    }
  }

  console.log("");
  console.log(`  ${brand()} ${fg("Diff")}`);
  console.log(`  ${dim("─".repeat(40))}`);

  if (newViolations.length === 0 && resolvedViolations.length === 0 && changedCalls.length === 0) {
    console.log(`  ${green("✓")} No behavioral changes detected.`);
    console.log("");
    return;
  }

  for (const v of newViolations) {
    console.log(`  ${red("+")} ${fg(v.tool)} ${red("NEW")} ${muted(v.details ?? v.reason ?? "")}`);
  }
  for (const v of resolvedViolations) {
    console.log(`  ${green("-")} ${fg(v.tool)} ${green("RESOLVED")} ${muted(v.details ?? v.reason ?? "")}`);
  }
  for (const c of changedCalls) {
    const dir = c.after < c.before ? green("↓") : c.after > c.before ? yellow("↑") : dim("=");
    console.log(`  ${dir} ${fg(c.tool)} ${muted(`${c.before} → ${c.after} calls`)}`);
  }

  console.log("");
  const parts: string[] = [];
  if (newViolations.length > 0) parts.push(`${newViolations.length} new`);
  if (resolvedViolations.length > 0) parts.push(`${resolvedViolations.length} resolved`);
  if (changedCalls.length > 0) parts.push(`${changedCalls.length} changed`);
  console.log(`  ${muted("Summary:")} ${fg(parts.join(" · "))}`);
  console.log("");

  process.exitCode = newViolations.length > 0 ? 1 : 0;
}
