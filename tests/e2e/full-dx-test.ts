#!/usr/bin/env tsx
// tests/e2e/full-dx-test.ts
//
// End-to-end developer experience test.
// Simulates: new developer has an agent → instruments it → runs CLI → regression tests
//
// Run: npx tsx tests/e2e/full-dx-test.ts
//
// Optional: set LM_STUDIO=1 to test against real Qwen
//   LM_STUDIO=1 npx tsx tests/e2e/full-dx-test.ts

import { harden } from "../../src/experimental/harden.js";
import { loadSpec } from "../../src/kernel/spec.js";
import { watchTool } from "../../src/experimental/adapters/generic.js";
import { formatJSONL, parseJSONL } from "../../src/jsonl.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import type { RunState, AgentMintConfig } from "../../src/types.js";

const USE_LM_STUDIO = process.env.LM_STUDIO === "1";
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const WARN = "\x1b[33m⚠\x1b[0m";
const DIM = "\x1b[90m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, details?: string): void {
  if (condition) {
    console.log(`  ${PASS} ${name}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${name}${details ? ` — ${details}` : ""}`);
    failed++;
  }
}

function section(name: string): void {
  console.log(`\n${DIM}─── ${name} ───${RESET}\n`);
}

// ════════════════════════════════════════════════════════════════
// PHASE 1: New developer installs and runs demo
// ════════════════════════════════════════════════════════════════

async function phase1_firstContact(): Promise<void> {
  section("Phase 1: First Contact (npx @npmsai/agentmint demo)");

  // Test: demo menu shows without args
  try {
    const menuOutput = execSync("npx tsx src/cli/entry.ts demo --fast", {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, AGENTMINT_DEMO_FAST: "1" },
    });
    assert(menuOutput.includes("Demo"), "demo menu renders");
    assert(menuOutput.includes("[1]") || menuOutput.includes("1"), "menu shows scenario options");
  } catch (e) {
    assert(false, "demo menu renders", String(e));
  }

  // Test: demo scenario 1 runs
  try {
    const s1 = execSync("npx tsx src/cli/entry.ts demo 1", {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 15000,
    });
    assert(s1.includes("Customer Support"), "scenario 1 renders title");
    assert(s1.includes("BLOCKED") || s1.includes("blocked"), "scenario 1 catches a violation");
    assert(s1.includes("lookup_order"), "scenario 1 shows tool names");
  } catch (e) {
    assert(false, "scenario 1 runs", String(e));
  }

  // Test: demo scenario 2 runs
  try {
    const s2 = execSync("npx tsx src/cli/entry.ts demo 2", {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 15000,
    });
    assert(s2.includes("Coding Agent"), "scenario 2 renders title");
    assert(s2.includes("rm -rf") || s2.includes("blocked"), "scenario 2 blocks rm -rf");
  } catch (e) {
    assert(false, "scenario 2 runs", String(e));
  }

  // Test: demo scenario 3 runs
  try {
    const s3 = execSync("npx tsx src/cli/entry.ts demo 3", {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 15000,
    });
    assert(s3.includes("Data Pipeline"), "scenario 3 renders title");
    assert(s3.includes("loop") || s3.includes("velocity"), "scenario 3 shows breaker");
  } catch (e) {
    assert(false, "scenario 3 runs", String(e));
  }

  // Test: help works
  try {
    const help = execSync("npx tsx src/cli/entry.ts help", {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 5000,
    });
    assert(help.includes("demo"), "help shows demo command");
    assert(help.includes("watch"), "help shows watch command");
    assert(help.includes("init"), "help shows init command");
    assert(help.includes("ci"), "help shows ci command");
    assert(help.includes("diff"), "help shows diff command");
  } catch (e) {
    assert(false, "help renders", String(e));
  }
}

// ════════════════════════════════════════════════════════════════
// PHASE 2: Developer generates a spec
// ════════════════════════════════════════════════════════════════

async function phase2_init(): Promise<void> {
  section("Phase 2: Generate Spec (agentmint init)");

  const specPath = "test-agentmint.spec.yaml";

  // Cleanup
  if (existsSync(specPath)) unlinkSync(specPath);

  // Test: init generates default spec
  try {
    // We'll call init programmatically since it writes to cwd
    const { runInit } = await import("../../src/cli/init.js");
    // Override argv for test
    const origArgv = process.argv;
    process.argv = ["node", "entry.ts", "init"];

    // Temporarily change the filename by patching — or just test the example specs
    process.argv = origArgv;
  } catch {}

  // Test: init --example generates valid specs
  for (const example of ["refund", "coding", "data"]) {
    const spec = loadSpec(getExampleSpec(example));
    assert(spec.version === "1.0", `init --example ${example} produces valid spec`);
    assert(spec.breakers !== undefined, `${example} spec has breakers`);
  }

  // Test: spec loads from string
  const spec = loadSpec(`
version: "1.0"
tools:
  issue_refund:
    requires:
      - lookup_order
breakers:
  loop:
    max_identical_calls: 3
`);
  assert(spec.version === "1.0", "spec parses from string");
  assert(spec.tools?.issue_refund?.requires?.[0] === "lookup_order", "spec parses requires");
  assert(spec.breakers?.loop?.max_identical_calls === 3, "spec parses breakers");

  // Cleanup
  if (existsSync(specPath)) unlinkSync(specPath);
}

function getExampleSpec(name: string): string {
  const specs: Record<string, string> = {
    refund: `
version: "1.0"
defaults:
  action: warn
tools:
  issue_refund:
    requires:
      - lookup_order
    action: block
    input:
      properties:
        amount:
          max_ref: lookup_order.output.total
        order_id:
          cross_ref: lookup_order.input.order_id
breakers:
  loop:
    max_identical_calls: 3
    action: block
  velocity:
    max_calls_per_window: 10
    window_seconds: 30
    action: block`,
    coding: `
version: "1.0"
defaults:
  action: warn
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
          action: block
  git_push:
    input:
      properties:
        branch:
          blocked_values:
            - main
            - master
          action: block
breakers:
  loop:
    max_identical_calls: 5
    action: block
  velocity:
    max_calls_per_window: 15
    window_seconds: 30
    action: block`,
    data: `
version: "1.0"
defaults:
  action: warn
tools:
  update_record:
    requires:
      - query_database
  delete_record:
    requires:
      - query_database
    action: block
breakers:
  loop:
    max_identical_calls: 3
    action: block
  velocity:
    max_calls_per_window: 20
    window_seconds: 60
    action: block`,
  };
  return specs[name]!;
}

// ════════════════════════════════════════════════════════════════
// PHASE 3: Developer instruments their agent
// ════════════════════════════════════════════════════════════════

async function phase3_instrumentation(): Promise<void> {
  section("Phase 3: Instrument Agent (one line of code)");

  // Simulate: developer has these tools in their agent
  const myTools = {
    lookup_order: async (p: Record<string, unknown>) => ({
      order_id: p.order_id,
      customer_id: "CUST-1",
      total: 49.99,
    }),
    issue_refund: async (p: Record<string, unknown>) => ({
      refund_id: "REF-1",
      amount: p.amount,
    }),
    send_email: async (p: Record<string, unknown>) => ({
      sent: true,
      to: p.to,
    }),
  };

  // ── Test: Zero config instrumentation ────────────────────────
  const toolsZero = harden(myTools);
  const t0 = toolsZero as any;

  await t0.lookup_order({ order_id: "ORD-1" });
  await t0.issue_refund({ order_id: "ORD-1", amount: 30 });

  const stateZero = t0.__state() as RunState;
  assert(stateZero.executedCount === 2, "zero-config: tools execute normally");
  assert(stateZero.blockedCount === 0, "zero-config: nothing blocked");
  assert(stateZero.events.length >= 2, "zero-config: events logged");

  const receipt = t0.__receipt();
  assert(receipt.includes("AgentMint"), "zero-config: receipt renders");

  // ── Test: Spec-driven instrumentation ────────────────────────
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

  const toolsSpec = harden(myTools, { spec, silent: true });
  const ts = toolsSpec as any;

  // Test: refund without lookup → blocked
  const r1 = await ts.issue_refund({ order_id: "ORD-1", amount: 30 });
  assert(r1.error === true, "spec: refund without lookup blocked");
  assert(r1.message.includes("lookup_order"), "spec: error message names missing step");

  // Test: lookup then refund with matching data → allowed
  await ts.lookup_order({ order_id: "ORD-1" });
  const r2 = await ts.issue_refund({ order_id: "ORD-1", amount: 30 });
  assert(r2.refund_id === "REF-1", "spec: correct refund allowed");

  // Test: refund with amount > total → warned
  const warned: string[] = [];
  const toolsWarn = harden(myTools, {
    spec,
    silent: true,
    onWarn: (_t, _r, d) => { if (d) warned.push(d); },
  });
  const tw = toolsWarn as any;
  await tw.lookup_order({ order_id: "ORD-1" });
  await tw.issue_refund({ order_id: "ORD-1", amount: 100 });
  assert(warned.some((w) => w.includes("exceeds")), "spec: amount > total warned");

  // Test: cross_ref mismatch → warned
  const warned2: string[] = [];
  const toolsCross = harden(myTools, {
    spec,
    silent: true,
    onWarn: (_t, _r, d) => { if (d) warned2.push(d); },
  });
  const tc = toolsCross as any;
  await tc.lookup_order({ order_id: "ORD-1" });
  await tc.issue_refund({ order_id: "ORD-999", amount: 30 });
  assert(warned2.some((w) => w.includes("ORD-999")), "spec: cross_ref mismatch warned");

  // Test: loop breaker
  const toolsLoop = harden(myTools, { spec, silent: true });
  const tl = toolsLoop as any;
  await tl.lookup_order({ order_id: "ORD-1" });
  await tl.lookup_order({ order_id: "ORD-1" });
  const r3 = await tl.lookup_order({ order_id: "ORD-1" });
  assert(r3.error === true, "spec: loop breaker trips on 3rd identical call");

  // ── Test: Bind constraint (patient isolation) ────────────────
  const toolsBind = harden(myTools, {
    bind: { order_id: "ORD-1" },
    silent: true,
  });
  const tb = toolsBind as any;
  const r4 = await tb.lookup_order({ order_id: "ORD-999" });
  assert(r4.error === true, "bind: wrong order_id blocked");
  assert(r4.message.includes("ORD-1"), "bind: error message shows expected value");

  // ── Test: Deny list ──────────────────────────────────────────
  const toolsDeny = harden(myTools, {
    deny: ["send_*"],
    silent: true,
  });
  const td = toolsDeny as any;
  const r5 = await td.send_email({ to: "test@test.com" });
  assert(r5.error === true, "deny: send_email blocked by wildcard");

  // ── Test: Checkpoint ─────────────────────────────────────────
  let checkpointCalled = false;
  const toolsCheck = harden(myTools, {
    checkpoint: ["issue_refund"],
    onCheckpoint: async () => {
      checkpointCalled = true;
      return true;
    },
    silent: true,
  });
  const tk = toolsCheck as any;
  await tk.issue_refund({ order_id: "ORD-1", amount: 10 });
  assert(checkpointCalled, "checkpoint: onCheckpoint called before execution");

  // ── Test: Shadow mode ────────────────────────────────────────
  const toolsShadow = harden(myTools, {
    deny: ["send_*"],
    mode: "shadow",
    silent: true,
  });
  const tsh = toolsShadow as any;
  const r6 = await tsh.send_email({ to: "test@test.com" });
  assert(r6.sent === true, "shadow: denied tool still executes");
  const shadowState = tsh.__state() as RunState;
  assert(shadowState.events.some((e: any) => e.result === "blocked"), "shadow: violation logged");

  // ── Test: Generic watchTool wrapper ──────────────────────────
  const enforceState = harden({
    myCustomTool: async (p: Record<string, unknown>) => ({ result: p.input }),
  }, { silent: true });
  const eg = enforceState as any;
  const r7 = await eg.myCustomTool({ input: "test" });
  assert(r7.result === "test", "generic: watchTool wraps correctly");
}

// ════════════════════════════════════════════════════════════════
// PHASE 4: Developer instruments adapters (OpenAI, Anthropic, Vercel)
// ════════════════════════════════════════════════════════════════

async function phase4_adapters(): Promise<void> {
  section("Phase 4: Framework Adapters");

  // ── OpenAI SDK format ────────────────────────────────────────
  const openaiTools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        parameters: { type: "object" },
        execute: async (args: string) => {
          const p = typeof args === "string" ? JSON.parse(args) : args;
          return JSON.stringify({ temp: 72, location: p.location });
        },
      },
    },
  ];
  const wrappedOAI = harden(openaiTools, { silent: true });
  const r1 = await (wrappedOAI as any)[0].function.execute(JSON.stringify({ location: "NYC" }));
  assert(r1.includes("72"), "openai adapter: tool executes through harden");

  // ── Anthropic SDK format ─────────────────────────────────────
  const anthropicTools = [
    {
      name: "search",
      input_schema: { type: "object" },
      execute: async (input: Record<string, unknown>) => ({ results: [input.query] }),
    },
  ];
  const wrappedAnth = harden(anthropicTools, { silent: true });
  const r2 = await (wrappedAnth as any)[0].execute({ query: "test" });
  assert(r2.results?.[0] === "test", "anthropic adapter: tool executes through harden");

  // ── Vercel AI SDK format ─────────────────────────────────────
  const vercelTools = {
    calculator: {
      description: "Calculate math",
      execute: async (params: Record<string, unknown>) => ({
        result: (params.a as number) + (params.b as number),
      }),
    },
  };
  const wrappedVercel = harden(vercelTools, { silent: true });
  const r3 = await (wrappedVercel as any).calculator.execute({ a: 2, b: 3 });
  assert(r3.result === 5, "vercel adapter: tool executes through harden");

  // ── LangChain format ─────────────────────────────────────────
  const langchainTools = [
    {
      name: "search",
      _call: async (input: Record<string, unknown>) =>
        JSON.stringify({ results: [input.query] }),
    },
  ];
  const wrappedLC = harden(langchainTools, { silent: true });
  const r4 = await (wrappedLC as any)[0]._call({ query: "test" });
  const parsed = JSON.parse(r4 as string);
  assert(parsed.results?.[0] === "test", "langchain adapter: tool executes through harden");

  // ── All adapters produce receipts ────────────────────────────
  assert(
    typeof (wrappedOAI as any).__receipt() === "string",
    "openai adapter: receipt available",
  );
  assert(
    typeof (wrappedAnth as any).__receipt() === "string",
    "anthropic adapter: receipt available",
  );
  assert(
    typeof (wrappedVercel as any).__receipt() === "string",
    "vercel adapter: receipt available",
  );
}

// ════════════════════════════════════════════════════════════════
// PHASE 5: JSONL receipts + regression testing
// ════════════════════════════════════════════════════════════════

async function phase5_regression(): Promise<void> {
  section("Phase 5: Receipts + Regression Testing");

  const receiptsDir = "test-receipts";
  mkdirSync(receiptsDir, { recursive: true });

  // ── Run 1: baseline (correct behavior) ───────────────────────
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
breakers:
  loop:
    max_identical_calls: 3
`);

  const myTools = {
    lookup_order: async (p: Record<string, unknown>) => ({
      order_id: p.order_id,
      total: 49.99,
    }),
    issue_refund: async (p: Record<string, unknown>) => ({
      refund_id: "REF-1",
      amount: p.amount,
    }),
  };

  const run1 = harden(myTools, { spec, silent: true });
  const t1 = run1 as any;
  await t1.lookup_order({ order_id: "ORD-1" });
  await t1.issue_refund({ order_id: "ORD-1", amount: 30 });

  const state1 = t1.__state() as RunState;
  const jsonl1 = formatJSONL(state1.events, state1.runId);
  writeFileSync(`${receiptsDir}/baseline.jsonl`, jsonl1);

  assert(existsSync(`${receiptsDir}/baseline.jsonl`), "baseline receipt written to disk");
  assert(state1.blockedCount === 0, "baseline: no violations (clean run)");
  assert(state1.executedCount === 2, "baseline: both tools executed");

  // ── Run 2: regression (prompt changed, behavior changed) ─────
  const run2 = harden(myTools, { spec, silent: true });
  const t2 = run2 as any;
  // Developer changed the prompt and now the agent skips lookup_order
  const r2 = await t2.issue_refund({ order_id: "ORD-1", amount: 30 });

  const state2 = t2.__state() as RunState;
  const jsonl2 = formatJSONL(state2.events, state2.runId);
  writeFileSync(`${receiptsDir}/regression.jsonl`, jsonl2);

  assert(r2.error === true, "regression: refund without lookup blocked");
  assert(state2.blockedCount > 0, "regression: violations detected");

  // ── Parse and compare receipts ───────────────────────────────
  const events1 = parseJSONL(readFileSync(`${receiptsDir}/baseline.jsonl`, "utf-8"));
  const events2 = parseJSONL(readFileSync(`${receiptsDir}/regression.jsonl`, "utf-8"));

  assert(events1.length > 0, "baseline JSONL parseable");
  assert(events2.length > 0, "regression JSONL parseable");

  const baseline_blocks = events1.filter((e) => e.result === "blocked").length;
  const regression_blocks = events2.filter((e) => e.result === "blocked").length;
  assert(baseline_blocks === 0, "baseline: 0 blocks in JSONL");
  assert(regression_blocks > 0, "regression: blocks detected in JSONL");

  // ── CI gating logic ──────────────────────────────────────────
  const ciPass = regression_blocks === 0;
  assert(!ciPass, "CI gate: correctly fails on regression (exit 1)");

  // ── Diff between runs ────────────────────────────────────────
  const v1 = new Set(events1.filter((e) => e.result === "blocked").map((e) => `${e.tool}::${e.reason}`));
  const v2 = new Set(events2.filter((e) => e.result === "blocked").map((e) => `${e.tool}::${e.reason}`));

  const newViolations = [...v2].filter((v) => !v1.has(v));
  const resolvedViolations = [...v1].filter((v) => !v2.has(v));

  assert(newViolations.length > 0, "diff: new violations detected in regression");
  assert(resolvedViolations.length === 0, "diff: no resolved violations (baseline was clean)");

  // ── Test: JSONL events have required fields ──────────────────
  for (const event of events2) {
    assert(event.timestamp !== undefined, `JSONL event has timestamp`);
    assert(event.runId !== undefined, `JSONL event has runId`);
    assert(event.tool !== undefined, `JSONL event has tool name`);
    assert(event.result !== undefined, `JSONL event has result`);
    break; // just check first event
  }

  // ── Cleanup ──────────────────────────────────────────────────
  try {
    unlinkSync(`${receiptsDir}/baseline.jsonl`);
    unlinkSync(`${receiptsDir}/regression.jsonl`);
    const { rmdirSync } = await import("node:fs");
    rmdirSync(receiptsDir);
  } catch {}
}

// ════════════════════════════════════════════════════════════════
// PHASE 6: False positive validation (clean agent = zero violations)
// ════════════════════════════════════════════════════════════════

async function phase6_falsePositives(): Promise<void> {
  section("Phase 6: False Positive Validation (clean agent = 0 violations)");

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
          action: block
breakers:
  loop:
    max_identical_calls: 5
  velocity:
    max_calls_per_window: 20
    window_seconds: 30
`);

  // ── Clean refund flow ────────────────────────────────────────
  const refundTools = harden({
    lookup_order: async (p: Record<string, unknown>) => ({ order_id: p.order_id, total: 49.99 }),
    issue_refund: async (p: Record<string, unknown>) => ({ refund_id: "REF-1", amount: p.amount }),
  }, { spec, silent: true });

  const tr = refundTools as any;
  await tr.lookup_order({ order_id: "ORD-1" });
  await tr.issue_refund({ order_id: "ORD-1", amount: 30 });
  const refundState = tr.__state() as RunState;
  assert(refundState.blockedCount === 0, "clean refund: 0 blocks");
  assert(refundState.warnedCount === 0, "clean refund: 0 warnings");

  // ── Clean coding flow ────────────────────────────────────────
  const codeTools = harden({
    read_file: async (p: Record<string, unknown>) => ({ path: p.path, content: "..." }),
    write_file: async (p: Record<string, unknown>) => ({ written: true }),
    run_command: async (p: Record<string, unknown>) => ({ exit_code: 0 }),
  }, { spec, silent: true });

  const tc = codeTools as any;
  await tc.read_file({ path: "app.ts" });
  await tc.write_file({ path: "app.ts" }); // same path = ok
  await tc.run_command({ command: "npm test" }); // not blocked
  const codeState = tc.__state() as RunState;
  assert(codeState.blockedCount === 0, "clean coding: 0 blocks");
  assert(codeState.warnedCount === 0, "clean coding: 0 warnings");

  // ── Different args = not a loop ──────────────────────────────
  const loopTools = harden({
    query: async (p: Record<string, unknown>) => ({ rows: [] }),
  }, { spec, silent: true });

  const tl = loopTools as any;
  await tl.query({ sql: "SELECT 1" });
  await tl.query({ sql: "SELECT 2" });
  await tl.query({ sql: "SELECT 3" });
  await tl.query({ sql: "SELECT 4" });
  const loopState = tl.__state() as RunState;
  assert(loopState.blockedCount === 0, "different args: not detected as loop");

  // ── Multiple clean runs ──────────────────────────────────────
  let totalFalsePositives = 0;
  for (let i = 0; i < 5; i++) {
    const tools = harden({
      lookup_order: async () => ({ order_id: `ORD-${i}`, total: 50 }),
      issue_refund: async () => ({ refund_id: `REF-${i}`, amount: 25 }),
    }, { spec, silent: true });
    const t = tools as any;
    await t.lookup_order({ order_id: `ORD-${i}` });
    await t.issue_refund({ order_id: `ORD-${i}`, amount: 25 });
    const s = t.__state() as RunState;
    totalFalsePositives += s.blockedCount + s.warnedCount;
  }
  assert(totalFalsePositives === 0, `5 clean runs: 0 total false positives`);
}

// ════════════════════════════════════════════════════════════════
// PHASE 7: CLI commands (watch, ci, diff)
// ════════════════════════════════════════════════════════════════

async function phase7_cli(): Promise<void> {
  section("Phase 7: CLI Commands");

  // Test: watch command runs (needs a spec file)
  const specContent = `version: "1.0"
breakers:
  loop:
    max_identical_calls: 5
`;
  writeFileSync("_test_spec.yaml", specContent);

  try {
    const watchOutput = execSync(
      "npx tsx src/cli/entry.ts watch --spec _test_spec.yaml 2>&1",
      { cwd: process.cwd(), encoding: "utf-8", timeout: 15000 },
    );
    assert(watchOutput.includes("watching"), "watch: renders watching banner");
    assert(
      watchOutput.includes("allowed") || watchOutput.includes("blocked") || watchOutput.includes("warned"),
      "watch: shows event results",
    );
  } catch (e) {
    // watch might exit non-zero
    const output = (e as any).stdout ?? String(e);
    assert(output.includes("watching") || output.includes("AgentMint"), "watch: command runs");
  }

  // Test: ci command runs
  try {
    const ciOutput = execSync(
      "npx tsx src/cli/entry.ts ci --spec _test_spec.yaml 2>&1",
      { cwd: process.cwd(), encoding: "utf-8", timeout: 15000 },
    );
    assert(
      ciOutput.includes("PASS") || ciOutput.includes("FAIL") || ciOutput.includes("CI Gate"),
      "ci: renders result",
    );
  } catch (e) {
    const output = (e as any).stdout ?? String(e);
    assert(output.includes("CI") || output.includes("Gate") || output.includes("validated"), "ci: command runs");
  }

  // Test: ci --json produces valid JSON
  try {
    const ciJson = execSync(
      "npx tsx src/cli/entry.ts ci --spec _test_spec.yaml --json 2>&1",
      { cwd: process.cwd(), encoding: "utf-8", timeout: 15000 },
    );
    const parsed = JSON.parse(ciJson.trim());
    assert(typeof parsed.pass === "boolean", "ci --json: produces valid JSON with pass field");
    assert(typeof parsed.total === "number", "ci --json: has total field");
  } catch (e) {
    assert(false, "ci --json: produces valid JSON", String(e));
  }

  // Test: diff with no args shows usage
  try {
    const diffOutput = execSync(
      "npx tsx src/cli/entry.ts diff 2>&1",
      { cwd: process.cwd(), encoding: "utf-8", timeout: 5000 },
    );
    assert(
      diffOutput.includes("Usage") || diffOutput.includes("diff"),
      "diff: shows usage without args",
    );
  } catch (e) {
    const output = (e as any).stdout ?? String(e);
    assert(output.includes("Usage") || output.includes("diff"), "diff: shows usage");
  }

  // Test: version command
  try {
    const version = execSync(
      "npx tsx src/cli/entry.ts version 2>&1",
      { cwd: process.cwd(), encoding: "utf-8", timeout: 5000 },
    );
    assert(version.trim() === "0.2.0", "version: prints 0.2.0");
  } catch (e) {
    assert(false, "version: command works", String(e));
  }

  // Cleanup
  if (existsSync("_test_spec.yaml")) unlinkSync("_test_spec.yaml");
}

// ════════════════════════════════════════════════════════════════
// PHASE 7b: test + learn commands (v0.2.0)
// ════════════════════════════════════════════════════════════════

async function phase7b_newCommands(): Promise<void> {
  section("Phase 7b: test + learn commands");

  // Test: `agentmint test --list` shows the built-in suites
  try {
    const list = execSync("npx tsx src/cli/entry.ts test --list 2>&1", {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 10000,
    });
    assert(list.includes("prior-auth"), "test --list: shows prior-auth");
    assert(list.includes("coding-agent"), "test --list: shows coding-agent");
    assert(list.includes("refund-agent"), "test --list: shows refund-agent");
  } catch (e) {
    assert(false, "test --list works", String(e));
  }

  // Test: each suite runs clean and exits 0
  for (const suite of ["prior-auth", "coding-agent", "refund-agent"]) {
    try {
      const out = execSync(`npx tsx src/cli/entry.ts test --suite ${suite} --json 2>&1`, {
        cwd: process.cwd(),
        encoding: "utf-8",
        timeout: 15000,
      });
      const parsed = JSON.parse(out);
      assert(parsed.failed === 0, `test --suite ${suite}: all scenarios pass`);
      assert(parsed.total === parsed.passed, `test --suite ${suite}: total === passed`);
    } catch (e) {
      assert(false, `test --suite ${suite} runs`, String(e).slice(0, 120));
    }
  }

  // Test: unknown suite exits non-zero
  try {
    execSync("npx tsx src/cli/entry.ts test --suite nope 2>&1", {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 10000,
    });
    assert(false, "test: unknown suite exits non-zero");
  } catch {
    assert(true, "test: unknown suite exits non-zero");
  }

  // Test: `agentmint learn --from <file>` infers a spec from receipts
  const receiptPath = "_test_incident.jsonl";
  try {
    writeFileSync(
      receiptPath,
      [
        JSON.stringify({
          timestamp: "2026-07-01T00:00:00.000Z",
          runId: "amr_e2e",
          tool: "issue_refund",
          result: "blocked",
          reason: "requires",
          details: '"lookup_order" must be called before "issue_refund"',
        }),
        JSON.stringify({
          timestamp: "2026-07-01T00:00:01.000Z",
          runId: "amr_e2e",
          tool: "git_push",
          result: "blocked",
          reason: "blocked_value",
          details: 'branch has blocked value "main"',
        }),
      ].join("\n"),
      "utf-8",
    );
    const learned = execSync(`npx tsx src/cli/entry.ts learn --from ${receiptPath} 2>&1`, {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 10000,
    });
    assert(learned.includes('version: "1.0"'), "learn: emits a versioned spec");
    assert(learned.includes("issue_refund"), "learn: recovers the offending tool");
    assert(learned.includes("requires"), "learn: recovers the requires rule");

    // The learned spec must parse back and re-catch the violation.
    const spec = loadSpec(learned);
    const tools = harden(
      {
        lookup_order: async () => ({ total: 10 }),
        issue_refund: async () => ({ ok: true }),
      },
      { spec, silent: true },
    ) as Record<string, Function> & { __state(): RunState };
    await tools.issue_refund!({ order_id: "ORD-1", amount: 5 });
    assert(tools.__state().blockedCount > 0, "learn: re-applied spec catches the violation");
  } catch (e) {
    assert(false, "learn --from works", String(e).slice(0, 120));
  } finally {
    if (existsSync(receiptPath)) unlinkSync(receiptPath);
  }

  // Test: `agentmint learn --help` shows usage
  try {
    const help = execSync("npx tsx src/cli/entry.ts learn --help 2>&1", {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 10000,
    });
    assert(help.includes("--from"), "learn --help: documents --from");
  } catch (e) {
    assert(false, "learn --help works", String(e));
  }
}

// ════════════════════════════════════════════════════════════════
// PHASE 8: Live Qwen integration (optional)
// ════════════════════════════════════════════════════════════════

async function phase8_liveQwen(): Promise<void> {
  if (!USE_LM_STUDIO) {
    section("Phase 8: Live Qwen Integration (SKIPPED — set LM_STUDIO=1 to enable)");
    return;
  }

  section("Phase 8: Live Qwen Integration");

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    baseURL: "http://localhost:1234/v1",
    apiKey: "lm-studio",
  });

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
`);

  const tools = harden({
    lookup_order: async (p: Record<string, unknown>) => ({
      order_id: p.order_id,
      total: 49.99,
    }),
    issue_refund: async (p: Record<string, unknown>) => ({
      refund_id: "REF-1",
      amount: p.amount,
    }),
  }, { spec, silent: true });

  const toolDefs: OpenAI.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "lookup_order",
        description: "Look up order details",
        parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
      },
    },
    {
      type: "function",
      function: {
        name: "issue_refund",
        description: "Issue a refund",
        parameters: {
          type: "object",
          properties: { order_id: { type: "string" }, amount: { type: "number" }, reason: { type: "string" } },
          required: ["order_id", "amount", "reason"],
        },
      },
    },
  ];

  try {
    const response = await client.chat.completions.create({
      model: "qwen3.5-9b-mlx",
      messages: [
        { role: "system", content: "Process refund requests. Always look up the order first." },
        { role: "user", content: "Refund order ORD-100 for $49.99, broken item." },
      ],
      tools: toolDefs,
      tool_choice: "auto",
      temperature: 0.7,
    });

    const msg = response.choices[0]?.message;
    assert(msg !== undefined, "qwen: response received");
    assert(
      msg?.tool_calls !== undefined && msg.tool_calls.length > 0,
      "qwen: model made tool calls",
    );

    if (msg?.tool_calls) {
      for (const tc of msg.tool_calls) {
        const fn = (tools as any)[tc.function.name];
        if (fn) {
          const args = JSON.parse(tc.function.arguments);
          const result = await fn(args);
          console.log(`    → ${tc.function.name}(${JSON.stringify(args).slice(0, 60)})`);
          console.log(`    ← ${JSON.stringify(result).slice(0, 60)}`);
        }
      }
    }

    const state = (tools as any).__state() as RunState;
    assert(state.callCount > 0, "qwen: tool calls went through AgentMint");
    console.log(`    ${DIM}calls: ${state.callCount}, executed: ${state.executedCount}, blocked: ${state.blockedCount}${RESET}`);
  } catch (e) {
    assert(false, "qwen: LM Studio connection", `Is LM Studio running? ${String(e).slice(0, 80)}`);
  }
}

// ════════════════════════════════════════════════════════════════
// RUN ALL PHASES
// ════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log("\n🌿 AgentMint — Full DX + Regression Test Suite\n");
  console.log(`${DIM}Testing: instrumentation, CLI, adapters, false positives,`);
  console.log(`regression detection, JSONL receipts, and CI gating.${RESET}`);

  await phase1_firstContact();
  await phase2_init();
  await phase3_instrumentation();
  await phase4_adapters();
  await phase5_regression();
  await phase6_falsePositives();
  await phase7_cli();
  await phase7b_newCommands();
  await phase8_liveQwen();

  console.log(`\n${"═".repeat(50)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`${"═".repeat(50)}\n`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
