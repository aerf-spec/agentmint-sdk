import { existsSync, readFileSync } from "node:fs";
import { loadSpec } from "../spec.js";
import { parseJSONL } from "../jsonl.js";
import type { JSONLEvent } from "../types.js";
import { brand, dim, fg, green, muted, red, yellow } from "./color.js";

export async function runCi(): Promise<void> {
  const args = process.argv.slice(3);
  const specIdx = args.indexOf("--spec");
  const specPath = specIdx >= 0 && args[specIdx + 1] ? args[specIdx + 1]! : "agentmint.spec.yaml";
  const receiptIdx = args.indexOf("--receipt");
  const receiptPath = receiptIdx >= 0 ? args[receiptIdx + 1] : undefined;
  const jsonMode = args.includes("--json");

  if (!existsSync(specPath)) {
    console.error(`\n  ${red("✗")} Spec not found: ${red(specPath)}`);
    console.error(`  ${muted("Run")} ${fg("npx @npmsai/agentmint init")} ${muted("to create one.")}\n`);
    process.exitCode = 1;
    return;
  }

  let events: JSONLEvent[] = [];

  if (receiptPath && existsSync(receiptPath)) {
    const content = readFileSync(receiptPath, "utf-8");
    events = parseJSONL(content);
  } else {
    // Run built-in validation scenario
    const { harden } = await import("../harden.js");
    const spec = loadSpec(readFileSync(specPath, "utf-8"));

    const mockTools: Record<string, (p: Record<string, unknown>) => Promise<unknown>> = {
      lookup_order: async (p) => ({ order_id: p.order_id, total: 49.99 }),
      issue_refund: async (p) => ({ refund_id: "REF-1", amount: p.amount }),
      read_file: async (p) => ({ path: p.path, content: "..." }),
      write_file: async (p) => ({ path: p.path, written: true }),
      run_command: async (p) => ({ command: p.command, exit_code: 0 }),
      query_database: async (p) => ({ sql: p.sql, rows: 100 }),
      update_record: async (p) => ({ id: p.id, updated: true }),
    };

    const tools = harden(mockTools, { spec, silent: true }) as Record<string, (p: Record<string, unknown>) => Promise<unknown>> & { __state(): import("../types.js").RunState };

    // Run a test sequence
    await tools.lookup_order!({ order_id: "ORD-1" });
    await tools.issue_refund!({ order_id: "ORD-1", amount: 30 });
    await tools.read_file!({ path: "app.ts" });
    await tools.write_file!({ path: "app.ts" });

    const state = tools.__state();
    // Convert state events to JSONLEvents for analysis
    events = state.events.map((e) => ({
      timestamp: e.timestamp,
      runId: state.runId,
      tool: e.tool,
      result: e.result,
      reason: e.reason,
      details: e.details,
    }));
  }

  const blocked = events.filter((e) => e.result === "blocked" || e.result === "killed");
  const warned = events.filter((e) => e.result === "warned");
  const allowed = events.filter((e) => e.result === "allowed" || e.result === "approved");

  if (jsonMode) {
    const result = {
      pass: blocked.length === 0,
      total: events.length,
      allowed: allowed.length,
      warned: warned.length,
      blocked: blocked.length,
      violations: blocked.map((e) => ({ tool: e.tool, reason: e.reason, details: e.details })),
    };
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = blocked.length > 0 ? 1 : 0;
    return;
  }

  console.log("");
  console.log(`  ${brand()} ${fg("CI Gate")}`);
  console.log(`  ${dim("─".repeat(40))}`);
  console.log(`  ${green("✓")} ${fg(String(allowed.length))} tool calls validated`);
  if (warned.length > 0) {
    console.log(`  ${yellow("⚠")} ${fg(String(warned.length))} warnings`);
    for (const w of warned.slice(0, 3)) {
      console.log(`    ${dim("↳")} ${muted(`${w.tool}: ${w.details ?? w.reason ?? ""}`)}`);
    }
  }
  if (blocked.length > 0) {
    console.log(`  ${red("✗")} ${fg(String(blocked.length))} blocked`);
    for (const b of blocked) {
      console.log(`    ${dim("↳")} ${muted(`${b.tool}: ${b.details ?? b.reason ?? ""}`)}`);
    }
  }

  console.log("");
  if (blocked.length > 0) {
    console.log(`  ${red("Result: FAIL")} ${dim(`(${blocked.length} block-level violation${blocked.length > 1 ? "s" : ""})`)}`);
    process.exitCode = 1;
  } else {
    console.log(`  ${green("Result: PASS")}`);
    process.exitCode = 0;
  }
  console.log("");
}
