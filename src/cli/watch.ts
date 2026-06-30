import { existsSync, readFileSync } from "node:fs";
import { harden } from "../harden.js";
import { loadSpec } from "../spec.js";
import type { AgentMintConfig, RunState } from "../types.js";
import { brand, dim, fg, icons, muted, red, yellow } from "./color.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runWatch(): Promise<void> {
  const args = process.argv.slice(3);
  const specIdx = args.indexOf("--spec");
  const specPath = specIdx >= 0 && args[specIdx + 1] ? args[specIdx + 1]! : "agentmint.spec.yaml";
  const jsonMode = args.includes("--json");

  if (!existsSync(specPath)) {
    console.log("");
    console.log(`  ${red("✗")} Spec not found: ${red(specPath)}`);
    console.log(`  ${muted("Run")} ${fg("agentmint init")} ${muted("to create one.")}`);
    console.log("");
    process.exitCode = 1;
    return;
  }

  const spec = loadSpec(readFileSync(specPath, "utf-8"));

  // In --json mode, stdout carries pure JSONL; suppress the human banner.
  if (!jsonMode) {
    console.log("");
    console.log(`  ${brand()} ${fg("watching")} ${dim(`(spec: ${specPath})`)}`);
    console.log("");
  }

  // Demo-mode watch: run a built-in scenario showing live events
  const mockTools: Record<string, (p: Record<string, unknown>) => Promise<unknown>> = {
    lookup_order: async (p) => ({ order_id: p.order_id, total: 49.99, customer_id: "CUST-1" }),
    issue_refund: async (p) => ({ refund_id: "REF-1", amount: p.amount }),
    read_file: async (p) => ({ path: p.path, content: "..." }),
    write_file: async (p) => ({ path: p.path, written: true }),
    run_command: async (p) => ({ command: p.command, exit_code: 0 }),
    git_push: async (p) => ({ branch: p.branch, pushed: true }),
    query_database: async (p) => ({ sql: p.sql, rows: 100 }),
    update_record: async (p) => ({ id: p.id, updated: true }),
  };

  const config: AgentMintConfig = {
    spec,
    silent: true,
    onWarn: (tool, reason, details) => {
      const ts = new Date().toLocaleTimeString();
      if (jsonMode) {
        process.stdout.write(JSON.stringify({ ts, tool, result: "warned", reason, details }) + "\n");
      } else {
        console.log(`  ${dim(ts)} ${icons.warned} ${yellow(tool)}  ${muted(details ?? reason)}`);
      }
    },
    onBlock: (tool, reason, details) => {
      const ts = new Date().toLocaleTimeString();
      if (jsonMode) {
        process.stdout.write(JSON.stringify({ ts, tool, result: "blocked", reason, details }) + "\n");
      } else {
        console.log(`  ${dim(ts)} ${icons.blocked} ${red(tool)}  ${muted(details ?? reason)}`);
      }
    },
  };

  const tools = harden(mockTools, config) as Record<string, (p: Record<string, unknown>) => Promise<unknown>> & { __state(): RunState };

  // Run through some calls showing live output
  const calls: Array<[string, Record<string, unknown>]> = [
    ["lookup_order", { order_id: "ORD-123" }],
    ["issue_refund", { order_id: "ORD-123", amount: 30 }],
    ["read_file", { path: "src/app.ts" }],
    ["write_file", { path: "src/app.ts" }],
    ["write_file", { path: "config.yaml" }],
    ["run_command", { command: "rm -rf /tmp" }],
    ["query_database", { sql: "SELECT * FROM users" }],
    ["query_database", { sql: "SELECT * FROM users" }],
    ["query_database", { sql: "SELECT * FROM users" }],
  ];

  for (const [name, params] of calls) {
    const fn = tools[name];
    if (!fn) continue;
    const result = await fn(params);
    const ts = new Date().toLocaleTimeString();
    const isBlock = result && typeof result === "object" && "error" in result;
    if (!isBlock) {
      if (jsonMode) {
        process.stdout.write(JSON.stringify({ ts, tool: name, result: "allowed" }) + "\n");
      } else {
        console.log(`  ${dim(ts)} ${icons.allowed} ${fg(name)}  ${dim("ok")}`);
      }
    }
    await sleep(100);
  }

  const state = tools.__state();
  if (!jsonMode) {
    console.log("");
    const parts = [`${state.executedCount} allowed`];
    if (state.warnedCount > 0) parts.push(`${state.warnedCount} warned`);
    if (state.blockedCount > 0) parts.push(`${state.blockedCount} blocked`);
    console.log(`  ${dim("──")} ${fg(parts.join(` ${dim("·")} `))} ${dim("──")}`);
    console.log("");
  }
}
