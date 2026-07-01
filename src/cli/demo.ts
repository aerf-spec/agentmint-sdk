import { readFileSync } from "node:fs";
import { harden } from "../harden.js";
import { loadSpec } from "../spec.js";
import type { AgentMintConfig, RunState } from "../types.js";
import { blue, bold, brand, dim, fg, green, icons, muted, red, yellow } from "./color.js";

const VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const BOX_WIDTH = 56;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visLen(s: string): number { return s.replace(ANSI_RE, "").length; }
function boxLine(c = ""): string { return `  ${blue("│")}${c}${" ".repeat(Math.max(0, BOX_WIDTH - visLen(c)))}${blue("│")}`; }
function boxTop(): string { return `  ${blue(`┌${"─".repeat(BOX_WIDTH)}┐`)}`; }
function boxBot(): string { return `  ${blue(`└${"─".repeat(BOX_WIDTH)}┘`)}`; }

function center(text: string): string {
  const pad = Math.max(0, Math.floor((BOX_WIDTH - visLen(text)) / 2));
  return " ".repeat(pad) + text;
}

async function logCall(
  name: string,
  result: unknown,
  delay = 150,
): Promise<void> {
  if (result && typeof result === "object" && "error" in result) {
    const br = result as { error: boolean; message: string };
    console.log(`  ${icons.blocked} ${red(name)}  ${red(bold("BLOCKED"))}`);
    console.log(`    ${dim("↳")} ${muted(br.message)}`);
  } else {
    console.log(`  ${icons.allowed} ${fg(name)}  ${dim("ok")}`);
  }
  await sleep(delay);
}

async function logWarn(name: string, details: string): Promise<void> {
  console.log(`  ${icons.warned} ${yellow(name)}  ${yellow("WARNED")}`);
  console.log(`    ${dim("↳")} ${muted(details)}`);
}

async function logHalt(name: string, details: string): Promise<void> {
  console.log(`  ${icons.killed} ${red(bold(name))}  ${red(bold("⊘ HALT"))}`);
  console.log(`    ${dim("↳")} ${muted(details)}`);
}

// ── Scenario 1: Customer Support ────────────────────────────────

async function scenario1(): Promise<void> {
  console.log("");
  console.log(boxTop());
  console.log(boxLine(center(`${brand()} ${fg("Scenario 1: Customer Support")}`)));
  console.log(boxLine(center(muted("A refund agent goes rogue"))));
  console.log(boxBot());
  console.log("");

  const spec = loadSpec(`
version: "1.0"
tools:
  issue_refund:
    requires:
      - lookup_order
    input:
      properties:
        amount:
          max_ref: lookup_order.output.total
        order_id:
          cross_ref: lookup_order.input.order_id
breakers:
  loop:
    max_identical_calls: 3
`);

  const mockTools: Record<string, (p: Record<string, unknown>) => Promise<unknown>> = {
    lookup_customer: async (p) => ({ customer_id: p.customer_id, name: "Alice Chen" }),
    lookup_order: async (p) => ({ order_id: p.order_id, customer_id: "CUST-200", total: 49.99, status: "delivered" }),
    issue_refund: async (p) => ({ refund_id: "REF-001", order_id: p.order_id, amount: p.amount, status: "processed" }),
    send_notification: async (p) => ({ sent: true, to: p.customer_id }),
  };

  const config: AgentMintConfig = { spec, silent: true };
  const tools = harden(mockTools, config) as Record<string, (p: Record<string, unknown>) => Promise<unknown>> & { __state(): RunState; __receipt(): string };

  // 1. Lookup customer — fine
  const r1 = await tools.lookup_customer!({ customer_id: "CUST-100" });
  await logCall("lookup_customer", r1);

  // 2. Issue refund WITHOUT lookup_order — BLOCKED (requires)
  const r2 = await tools.issue_refund!({ order_id: "ORD-500", amount: 200 });
  await logCall("issue_refund", r2);

  // 3. Lookup order — fine
  const r3 = await tools.lookup_order!({ order_id: "ORD-123" });
  await logCall("lookup_order", r3);

  // 4. Issue refund with WRONG order_id + amount exceeds total — WARNED
  const warned: string[] = [];
  // Re-wrap to capture warns
  const tools2 = harden(mockTools, { ...config, onWarn: (_t: string, _r: string, d?: string) => { if (d) warned.push(d); } }) as Record<string, (p: Record<string, unknown>) => Promise<unknown>> & { __state(): RunState };
  // Replay the lookup so session has data
  await tools2.lookup_order!({ order_id: "ORD-123" });
  const r4 = await tools2.issue_refund!({ order_id: "ORD-456", amount: 75.00 });
  if (warned.length > 0) {
    for (const w of warned) await logWarn("issue_refund", w);
  } else {
    await logCall("issue_refund", r4);
  }

  // 5. Issue refund correctly — fine
  const r5 = await tools2.issue_refund!({ order_id: "ORD-123", amount: 30.00 });
  await logCall("issue_refund", r5);

  console.log("");
  console.log(`  ${muted("What just happened:")}`);
  console.log(`    ${green("✓")} ${fg("Refund without lookup")} → ${red("blocked")} ${dim("(requires violation)")}`);
  console.log(`    ${yellow("⚠")} ${fg("Wrong order_id + amount > total")} → ${yellow("warned")} ${dim("(cross_ref + max_ref)")}`);
  console.log(`    ${green("✓")} ${fg("Correct refund")} → ${green("allowed")}`);
}

// ── Scenario 2: Coding Agent ────────────────────────────────────

async function scenario2(): Promise<void> {
  console.log("");
  console.log(boxTop());
  console.log(boxLine(center(`${brand()} ${fg("Scenario 2: Coding Agent")}`)));
  console.log(boxLine(center(muted("A code agent touches files it shouldn't"))));
  console.log(boxBot());
  console.log("");

  const spec = loadSpec(`
version: "1.0"
tools:
  write_file:
    input:
      properties:
        path:
          cross_ref: read_file.input.path
  run_command:
    input:
      properties:
        command:
          blocked_patterns:
            - "rm -rf"
            - "git reset --hard"
            - "DROP TABLE"
            - "sudo"
          action: block
  git_push:
    input:
      properties:
        branch:
          blocked_values:
            - main
            - master
            - production
          action: block
breakers:
  loop:
    max_identical_calls: 5
    action: block
  velocity:
    max_calls_per_window: 10
    window_seconds: 30
    action: block
`);

  const mockTools: Record<string, (p: Record<string, unknown>) => Promise<unknown>> = {
    read_file: async (p) => ({ path: p.path, content: "// file contents..." }),
    write_file: async (p) => ({ path: p.path, written: true }),
    run_command: async (p) => ({ command: p.command, stdout: "output", exit_code: 0 }),
    git_push: async (p) => ({ branch: p.branch, pushed: true }),
  };

  const warns: string[] = [];
  const blocks: string[] = [];
  const config: AgentMintConfig = {
    spec,
    silent: true,
    onWarn: (_t, _r, d) => { if (d) warns.push(d); },
    onBlock: (_t, _r, d) => { if (d) blocks.push(d); },
  };
  const tools = harden(mockTools, config) as Record<string, (p: Record<string, unknown>) => Promise<unknown>> & { __state(): RunState; __receipt(): string };

  // 1. read_file — fine
  const r1 = await tools.read_file!({ path: "src/utils.ts" });
  await logCall("read_file", r1);

  // 2. write_file to same path — fine (cross_ref matches)
  const r2 = await tools.write_file!({ path: "src/utils.ts" });
  await logCall("write_file", r2);

  // 3. write_file to DIFFERENT path — WARNED
  warns.length = 0;
  const r3 = await tools.write_file!({ path: "config.yaml" });
  if (warns.length > 0) {
    await logWarn("write_file", warns[0]!);
  } else {
    await logCall("write_file", r3);
  }

  // 4. run_command with "rm -rf" — BLOCKED
  const r4 = await tools.run_command!({ command: "rm -rf node_modules" });
  if (r4 && typeof r4 === "object" && "error" in r4) {
    await logHalt("run_command", `blocked pattern: "rm -rf"`);
  }

  // 5. git_push to "main" — BLOCKED
  const r5 = await tools.git_push!({ branch: "main" });
  if (r5 && typeof r5 === "object" && "error" in r5) {
    await logHalt("git_push", `blocked value: "main"`);
  }

  console.log("");
  console.log(`  ${muted("What just happened:")}`);
  console.log(`    ${yellow("⚠")} ${fg("Write to unread file")} → ${yellow("warned")} ${dim("(cross_ref mismatch)")}`);
  console.log(`    ${red("⊘")} ${fg("rm -rf command")} → ${red("blocked")} ${dim("(blocked pattern)")}`);
  console.log(`    ${red("⊘")} ${fg("Push to main")} → ${red("blocked")} ${dim("(blocked value)")}`);
}

// ── Scenario 3: Data Pipeline ───────────────────────────────────

async function scenario3(): Promise<void> {
  console.log("");
  console.log(boxTop());
  console.log(boxLine(center(`${brand()} ${fg("Scenario 3: Data Pipeline")}`)));
  console.log(boxLine(center(muted("A data agent enters a retry loop"))));
  console.log(boxBot());
  console.log("");

  const spec = loadSpec(`
version: "1.0"
breakers:
  loop:
    max_identical_calls: 3
    action: block
  velocity:
    max_calls_per_window: 6
    window_seconds: 30
    action: block
`);

  const mockTools: Record<string, (p: Record<string, unknown>) => Promise<unknown>> = {
    query_database: async (p) => ({ sql: p.sql, rows: 10000, data: [{ id: 1 }] }),
    update_record: async (p) => ({ table: p.table, id: p.id, updated: true }),
  };

  const config: AgentMintConfig = { spec, silent: true };
  const tools = harden(mockTools, config) as Record<string, (p: Record<string, unknown>) => Promise<unknown>> & { __state(): RunState };

  // 1-2. Same query twice — fine
  for (let i = 1; i <= 2; i++) {
    await tools.query_database!({ sql: "SELECT * FROM orders WHERE status = 'pending'" });
    console.log(`  ${icons.allowed} ${fg("query_database")}  ${dim(`identical call ${i}/3`)}`);
    await sleep(80);
  }

  // 3. Same query third time — LOOP BREAKER
  const r3 = await tools.query_database!({ sql: "SELECT * FROM orders WHERE status = 'pending'" });
  if (r3 && typeof r3 === "object" && "error" in r3) {
    await logHalt("query_database", "loop breaker: 3 identical calls");
  } else {
    console.log(`  ${icons.allowed} ${fg("query_database")}  ${dim("identical call 3/3")}`);
  }

  // 4-5. Different update_record calls — fine
  for (let i = 1; i <= 2; i++) {
    const r = await tools.update_record!({ table: "orders", id: i });
    await logCall("update_record", r, 50);
  }

  // 6+. Rapid update_records — VELOCITY BREAKER
  let velocityHit = false;
  for (let i = 3; i <= 8; i++) {
    const r = await tools.update_record!({ table: "orders", id: i });
    if (r && typeof r === "object" && "error" in r) {
      if (!velocityHit) {
        await logHalt("update_record", `velocity breaker: 6+ calls in 30s window`);
        velocityHit = true;
      }
    } else {
      console.log(`  ${dim("↷")} ${dim(`update_record`)}  ${dim(`call ${i}`)}`);
    }
    await sleep(20);
  }

  console.log("");
  console.log(`  ${muted("What just happened:")}`);
  console.log(`    ${red("⊘")} ${fg("3 identical queries")} → ${red("loop breaker")} ${dim("tripped")}`);
  console.log(`    ${red("⊘")} ${fg("Rapid updates")} → ${red("velocity breaker")} ${dim("tripped")}`);
}

// ── Scenario a: Coding Agent Stress Test ────────────────────────

async function scenarioA(): Promise<void> {
  console.log("");
  console.log(boxTop());
  console.log(boxLine(center(`${brand()} ${fg("Coding Agent Stress Test")}`)));
  console.log(boxLine());
  console.log(boxLine(center(muted(`Task: "Fix the failing test in src/utils.ts"`))));
  console.log(boxLine(center(dim("12 tool calls · 5 rules · 1 breaker"))));
  console.log(boxBot());
  console.log("");

  const agentTools: Record<string, (p: Record<string, unknown>) => Promise<unknown>> = {
    read_file: async (p) => ({
      path: p.path,
      content: String(p.path) === ".env"
        ? "DATABASE_URL=postgres://admin:S3cret@prod:5432\nSTRIPE_KEY=sk_live_abc"
        : "export function daysInMonth(m: number) { return m === 2 ? 28 : 30; }"
    }),
    write_file: async (p) => ({ path: p.path, written: true }),
    run_command: async (p) => ({
      exit_code: String(p.command).includes("npm test") ? 1 : 0,
      stdout: String(p.command).includes("npm test") ? "" : "ok",
      stderr: String(p.command).includes("npm test") ? "expected 29 got 28" : ""
    }),
    run_tests: async (p) => ({
      suite: p.suite, passed: 8, failed: 1,
      error: "daysInMonth(2,2024): expected 29, got 28"
    }),
    git_commit: async (p) => ({ sha: "a1b2c3d", message: p.message }),
    git_push: async (p) => ({ pushed: true, branch: p.branch }),
  };

  const spec = loadSpec(`
version: "1.0"
tools:
  write_file:
    requires: [read_file]
    input:
      properties:
        path:
          cross_ref: read_file.input.path
  read_file:
    input:
      properties:
        path:
          blocked_patterns: [".env", ".git/config", "*.pem"]
          action: block
  run_command:
    input:
      properties:
        command:
          blocked_patterns: ["rm -rf", "git reset --hard", "curl", "wget", "sudo"]
          action: block
  git_push:
    requires: [run_tests]
    input:
      properties:
        branch:
          blocked_values: ["main", "master", "production"]
          action: block
  git_commit:
    requires: [run_tests]
breakers:
  loop:
    max_identical_calls: 3
`);

  let lastWarn: string | null = null;
  const config: AgentMintConfig = {
    spec,
    silent: true,
    onWarn: (_t, _r, d) => { if (d) lastWarn = d; },
  };
  const tools = harden(agentTools, config) as Record<string, (p: Record<string, unknown>) => Promise<unknown>> & { __state(): RunState };

  const isBlocked = (r: unknown): r is { error: true; message: string } =>
    !!r && typeof r === "object" && (r as { error?: unknown }).error === true;

  // Run one call and render its real result (blocked / warned / allowed).
  async function call(
    name: string,
    fn: () => Promise<unknown>,
    note: string,
  ): Promise<void> {
    lastWarn = null;
    const r = await fn();
    if (isBlocked(r)) {
      console.log(`  ${icons.blocked} ${red(name)}  ${red(bold("BLOCKED"))}  ${dim(note)}`);
    } else if (lastWarn) {
      console.log(`  ${icons.warned} ${yellow(name)}  ${yellow("WARNED")}  ${dim(note)}`);
    } else {
      console.log(`  ${icons.allowed} ${fg(name)}  ${dim("ok")}  ${dim(note)}`);
    }
    await sleep(120);
  }

  await call("read_file", () => tools.read_file!({ path: "src/utils.ts" }), "open the buggy file");
  await call("write_file", () => tools.write_file!({ path: "src/utils.ts", content: "// fixed" }), "edit the file it just read");
  await call("read_file", () => tools.read_file!({ path: ".env" }), "reach for credentials");
  await call("write_file", () => tools.write_file!({ path: "package.json", content: "{}" }), "edit a file it never read");
  await call("git_commit", () => tools.git_commit!({ message: "fix: leap year" }), "commit before tests pass");
  await call("run_tests", () => tools.run_tests!({ suite: "unit" }), "run the suite");
  await call("run_tests", () => tools.run_tests!({ suite: "unit" }), "same suite again");
  await call("run_tests", () => tools.run_tests!({ suite: "unit" }), "and again — retry loop");
  await call("run_command", () => tools.run_command!({ command: "rm -rf dist && npm run build" }), "clean and rebuild");
  await call("git_push", () => tools.git_push!({ branch: "main" }), "push straight to main");
  await call("run_tests", () => tools.run_tests!({ suite: "integration" }), "recover: different suite");
  await call("git_push", () => tools.git_push!({ branch: "fix/leap-year" }), "recover: safe branch");

  const st = tools.__state();
  const calls = st.callCount;
  const blocked = st.blockedCount;
  const warned = st.warnedCount;
  const allowed = st.executedCount - st.warnedCount;

  console.log("");
  console.log(boxTop());
  console.log(boxLine(center(fg("Receipt"))));
  console.log(boxLine());
  console.log(boxLine(center(
    `${muted("Calls:")} ${fg(String(calls))}  ${muted("Allowed:")} ${green(String(allowed))}  ${muted("Blocked:")} ${red(String(blocked))}  ${muted("Warned:")} ${yellow(String(warned))}`,
  )));
  console.log(boxLine());
  console.log(boxLine(`  ${muted("Caught:")}`));
  console.log(boxLine(`    ${red("·")} ${fg(".env credential read")}`));
  console.log(boxLine(`    ${yellow("·")} ${fg("Edit to a file the agent never read")}`));
  console.log(boxLine(`    ${red("·")} ${fg("Commit before tests passed")}`));
  console.log(boxLine(`    ${red("·")} ${fg("Test retry loop (3 identical calls)")}`));
  console.log(boxLine(`    ${red("·")} ${fg("rm -rf in a shell command")}`));
  console.log(boxLine(`    ${red("·")} ${fg("Push to main")}`));
  console.log(boxBot());
  console.log("");
  console.log(`  ${green("✓")} ${muted("Recovered: ran integration tests, pushed to")} ${fg("fix/leap-year")}`);
}

// ── Scenario selector ───────────────────────────────────────────

async function showMenu(): Promise<void> {
  console.log("");
  console.log(boxTop());
  console.log(boxLine(center(`${brand()} ${fg("Demo")}`)));
  console.log(boxLine());
  console.log(boxLine(`  ${fg("[1]")} Customer Support — refund gone wrong`));
  console.log(boxLine(`  ${fg("[2]")} Coding Agent — rogue file operations`));
  console.log(boxLine(`  ${fg("[3]")} Data Pipeline — runaway queries`));
  console.log(boxLine(`  ${fg("[a]")} Coding Agent — 12-call stress test`));
  console.log(boxLine());
  console.log(boxLine(`  ${muted("Usage:")} npx @npmsai/agentmint demo ${dim("[1|2|3|a]")}`));
  console.log(boxBot());
  console.log("");
}

export async function runDemo(scenarioArg?: string): Promise<void> {
  const arg = scenarioArg ?? process.argv[3];

  if (!arg) {
    await showMenu();
    return;
  }

  if (arg === "1") {
    await scenario1();
  } else if (arg === "2") {
    await scenario2();
  } else if (arg === "3") {
    await scenario3();
  } else if (arg === "a") {
    await scenarioA();
  } else {
    console.log(`  ${red("✗")} Unknown scenario: ${red(arg)}. Use 1, 2, 3, or a.`);
  }

  console.log("");
  console.log(`    ${dim("$")} npm install @npmsai/agentmint`);
  console.log("");
  console.log(`    ${muted("import { harden } from '@npmsai/agentmint'")}`);
  console.log(`    ${muted("const tools = harden(myTools)")}`);
  console.log("");
  console.log(`  ${dim(`${brand()} v${VERSION}`)}`);
  console.log("");
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("/demo.ts") || process.argv[1].endsWith("/demo.js"));

if (isMain) {
  void runDemo().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n  ${red("✗")} ${message}\n`);
    process.exitCode = 1;
  });
}
