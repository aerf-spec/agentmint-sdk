import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { harden } from "../src/harden.js";
import { loadSpec } from "../src/spec.js";
import { watchTool } from "../src/adapters/generic.js";
import { wrapAll as wrapAnthropic } from "../src/adapters/anthropic.js";
import { formatJSONL, parseJSONL } from "../src/jsonl.js";
import { createSession, recordInput, recordOutput, resolveRef, hashArgs } from "../src/session.js";
import { validateInputCrossRefs, validateOutputCrossRefs, checkRequires } from "../src/cross-ref.js";
import { checkBreakers } from "../src/breakers.js";
import type { AgentMintConfig, RunState, EnforcerFn } from "../src/types.js";

// ── Spec Parser Tests ──────────────────────────────────────────

describe("spec parser", () => {
  test("parses full spec", () => {
    const spec = loadSpec(`
version: "1.0"
defaults:
  action: warn
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
    max_identical_calls: 5
    action: block
`);
    assert.equal(spec.version, "1.0");
    assert.equal(spec.defaults?.action, "warn");
    assert.deepEqual(spec.tools?.issue_refund?.requires, ["lookup_order"]);
    assert.equal(spec.tools?.issue_refund?.input?.properties?.amount?.max_ref, "lookup_order.output.total");
    assert.equal(spec.breakers?.loop?.max_identical_calls, 5);
    assert.equal(spec.breakers?.loop?.action, "block");
  });

  test("rejects missing version", () => {
    assert.throws(() => loadSpec("tools:\n  foo:\n    requires:\n      - bar"), /version/);
  });

  test("parses blocked patterns", () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  run_command:
    input:
      properties:
        command:
          blocked_patterns:
            - "rm -rf"
            - "DROP TABLE"
          action: block
`);
    assert.deepEqual(spec.tools?.run_command?.input?.properties?.command?.blocked_patterns, ["rm -rf", "DROP TABLE"]);
    assert.equal(spec.tools?.run_command?.input?.properties?.command?.action, "block");
  });

  test("parses blocked values", () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  git_push:
    input:
      properties:
        branch:
          blocked_values:
            - main
            - master
          action: block
`);
    assert.deepEqual(spec.tools?.git_push?.input?.properties?.branch?.blocked_values, ["main", "master"]);
  });
});

// ── Session Store Tests ────────────────────────────────────────

describe("session store", () => {
  test("records and resolves input", () => {
    const s = createSession();
    recordInput(s, "lookup", { id: "123" });
    const ref = resolveRef(s, "lookup.input.id");
    assert.equal(ref.found, true);
    assert.equal(ref.value, "123");
  });

  test("records and resolves output", () => {
    const s = createSession();
    recordOutput(s, "lookup", { total: 49.99, status: "ok" });
    const ref = resolveRef(s, "lookup.output.total");
    assert.equal(ref.found, true);
    assert.equal(ref.value, 49.99);
  });

  test("returns not found for missing tool", () => {
    const s = createSession();
    const ref = resolveRef(s, "missing.output.field");
    assert.equal(ref.found, false);
  });

  test("hash consistency", () => {
    const h1 = hashArgs("tool", { a: 1, b: 2 });
    const h2 = hashArgs("tool", { b: 2, a: 1 });
    assert.equal(h1, h2); // same regardless of key order

    const h3 = hashArgs("tool", { a: 1, b: 3 });
    assert.notEqual(h1, h3); // different args = different hash
  });

  test("call history grows", () => {
    const s = createSession();
    recordInput(s, "a", { x: 1 });
    recordInput(s, "b", { y: 2 });
    assert.equal(s.callHistory.length, 2);
  });
});

// ── Cross-Ref Tests ────────────────────────────────────────────

describe("cross-ref validation", () => {
  test("cross_ref match passes", () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  refund:
    input:
      properties:
        order_id:
          cross_ref: lookup.input.order_id
`);
    const s = createSession();
    recordInput(s, "lookup", { order_id: "ORD-1" });
    const violations = validateInputCrossRefs("refund", { order_id: "ORD-1" }, spec, s);
    assert.equal(violations.length, 0);
  });

  test("cross_ref mismatch detected", () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  refund:
    input:
      properties:
        order_id:
          cross_ref: lookup.input.order_id
`);
    const s = createSession();
    recordInput(s, "lookup", { order_id: "ORD-1" });
    const violations = validateInputCrossRefs("refund", { order_id: "ORD-999" }, spec, s);
    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.type, "cross_ref");
    assert.ok(violations[0]!.details.includes("ORD-999"));
  });

  test("max_ref under limit passes", () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  refund:
    input:
      properties:
        amount:
          max_ref: lookup.output.total
`);
    const s = createSession();
    recordOutput(s, "lookup", { total: 50 });
    const v = validateInputCrossRefs("refund", { amount: 30 }, spec, s);
    assert.equal(v.length, 0);
  });

  test("max_ref over limit detected", () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  refund:
    input:
      properties:
        amount:
          max_ref: lookup.output.total
`);
    const s = createSession();
    recordOutput(s, "lookup", { total: 50 });
    const v = validateInputCrossRefs("refund", { amount: 75 }, spec, s);
    assert.equal(v.length, 1);
    assert.equal(v[0]!.type, "max_ref");
  });

  test("blocked pattern detected", () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  cmd:
    input:
      properties:
        command:
          blocked_patterns:
            - "rm -rf"
          action: block
`);
    const s = createSession();
    const v = validateInputCrossRefs("cmd", { command: "rm -rf /tmp" }, spec, s);
    assert.equal(v.length, 1);
    assert.equal(v[0]!.type, "blocked_pattern");
    assert.equal(v[0]!.action, "block");
  });

  test("blocked value detected", () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  push:
    input:
      properties:
        branch:
          blocked_values:
            - main
          action: block
`);
    const s = createSession();
    const v = validateInputCrossRefs("push", { branch: "main" }, spec, s);
    assert.equal(v.length, 1);
    assert.equal(v[0]!.type, "blocked_value");
  });

  test("requires with missing step", () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  refund:
    requires:
      - lookup
`);
    const completed = new Set<string>();
    const v = checkRequires("refund", spec, completed);
    assert.equal(v.length, 1);
    assert.equal(v[0]!.type, "requires");
  });

  test("requires with completed step passes", () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  refund:
    requires:
      - lookup
`);
    const completed = new Set(["lookup"]);
    const v = checkRequires("refund", spec, completed);
    assert.equal(v.length, 0);
  });
});

// ── Breaker Tests ──────────────────────────────────────────────

describe("circuit breakers", () => {
  test("loop breaker trips", () => {
    const s = createSession();
    recordInput(s, "query", { sql: "SELECT 1" });
    recordInput(s, "query", { sql: "SELECT 1" });
    recordInput(s, "query", { sql: "SELECT 1" });
    const v = checkBreakers("query", { sql: "SELECT 1" }, s, { loop: { max_identical_calls: 3 } }, 0);
    assert.equal(v.length, 1);
    assert.equal(v[0]!.type, "loop_breaker");
  });

  test("loop breaker passes under limit", () => {
    const s = createSession();
    recordInput(s, "query", { sql: "SELECT 1" });
    recordInput(s, "query", { sql: "SELECT 1" });
    const v = checkBreakers("query", { sql: "SELECT 1" }, s, { loop: { max_identical_calls: 3 } }, 0);
    assert.equal(v.length, 0);
  });

  test("loop breaker ignores different args", () => {
    const s = createSession();
    recordInput(s, "query", { sql: "SELECT 1" });
    recordInput(s, "query", { sql: "SELECT 2" });
    recordInput(s, "query", { sql: "SELECT 3" });
    const v = checkBreakers("query", { sql: "SELECT 4" }, s, { loop: { max_identical_calls: 3 } }, 0);
    assert.equal(v.length, 0);
  });

  test("velocity breaker trips", () => {
    const s = createSession();
    for (let i = 0; i < 6; i++) {
      recordInput(s, "update", { id: i });
    }
    const v = checkBreakers("update", { id: 7 }, s, {
      velocity: { max_calls_per_window: 6, window_seconds: 30 }
    }, 0);
    assert.equal(v.length, 1);
    assert.equal(v[0]!.type, "velocity_breaker");
  });

  test("cost breaker trips", () => {
    const s = createSession();
    const v = checkBreakers("call", {}, s, { cost: { max_usd: 5 } }, 5.01);
    assert.equal(v.length, 1);
    assert.equal(v[0]!.type, "cost_breaker");
  });
});

// ── Full Integration: Rogue Agent Scenarios ────────────────────

describe("rogue agent: refund flow", () => {
  test("blocks refund without lookup", async () => {
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
      lookup_order: async (p: Record<string, unknown>) => ({ order_id: p.order_id, total: 50 }),
      issue_refund: async (p: Record<string, unknown>) => ({ refunded: true, amount: p.amount }),
    }, { spec, silent: true });

    const t = tools as any;
    const r = await t.issue_refund({ order_id: "ORD-1", amount: 30 });
    assert.equal(r.error, true);
    assert.ok(r.message.includes("lookup_order"));
  });

  test("warns on amount exceeding total", async () => {
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
    const warned: string[] = [];
    const tools = harden({
      lookup_order: async () => ({ total: 50 }),
      issue_refund: async (p: Record<string, unknown>) => ({ refunded: true, amount: p.amount }),
    }, { spec, silent: true, onWarn: (_t, _r, d) => { if (d) warned.push(d); } });

    const t = tools as any;
    await t.lookup_order({ order_id: "ORD-1" });
    await t.issue_refund({ order_id: "ORD-1", amount: 100 });
    assert.ok(warned.some((w) => w.includes("exceeds max 50")));
  });
});

describe("rogue agent: coding agent", () => {
  test("blocks rm -rf", async () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  run_command:
    input:
      properties:
        command:
          blocked_patterns:
            - "rm -rf"
          action: block
`);
    const tools = harden({
      run_command: async (p: Record<string, unknown>) => ({ exit_code: 0 }),
    }, { spec, silent: true });

    const t = tools as any;
    const r = await t.run_command({ command: "rm -rf /" });
    assert.equal(r.error, true);
  });

  test("blocks push to main", async () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  git_push:
    input:
      properties:
        branch:
          blocked_values:
            - main
          action: block
`);
    const tools = harden({
      git_push: async (p: Record<string, unknown>) => ({ pushed: true }),
    }, { spec, silent: true });

    const t = tools as any;
    const r = await t.git_push({ branch: "main" });
    assert.equal(r.error, true);
  });

  test("warns on write to unread file", async () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  write_file:
    input:
      properties:
        path:
          cross_ref: read_file.input.path
`);
    const warned: string[] = [];
    const tools = harden({
      read_file: async (p: Record<string, unknown>) => ({ content: "..." }),
      write_file: async (p: Record<string, unknown>) => ({ written: true }),
    }, { spec, silent: true, onWarn: (_t, _r, d) => { if (d) warned.push(d); } });

    const t = tools as any;
    await t.read_file({ path: "app.ts" });
    await t.write_file({ path: "config.yaml" }); // different path = cross_ref warn
    assert.ok(warned.some((w) => w.includes("config.yaml")));
  });

  test("allows write to read file", async () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  write_file:
    input:
      properties:
        path:
          cross_ref: read_file.input.path
`);
    const warned: string[] = [];
    const tools = harden({
      read_file: async () => ({ content: "..." }),
      write_file: async () => ({ written: true }),
    }, { spec, silent: true, onWarn: (_t, _r, d) => { if (d) warned.push(d); } });

    const t = tools as any;
    await t.read_file({ path: "app.ts" });
    await t.write_file({ path: "app.ts" }); // same path = OK
    assert.equal(warned.length, 0);
  });
});

describe("rogue agent: data pipeline", () => {
  test("loop breaker stops identical queries", async () => {
    const spec = loadSpec(`
version: "1.0"
breakers:
  loop:
    max_identical_calls: 3
    action: block
`);
    const tools = harden({
      query: async () => ({ rows: [] }),
    }, { spec, silent: true });

    const t = tools as any;
    await t.query({ sql: "SELECT 1" }); // 1
    await t.query({ sql: "SELECT 1" }); // 2
    const r3 = await t.query({ sql: "SELECT 1" }); // 3 = trip
    assert.equal(r3.error, true);
    assert.ok(r3.message.includes("identical"));
  });

  test("velocity breaker stops rapid calls", async () => {
    const spec = loadSpec(`
version: "1.0"
breakers:
  velocity:
    max_calls_per_window: 5
    window_seconds: 60
    action: block
`);
    const tools = harden({
      update: async (p: Record<string, unknown>) => ({ updated: true }),
    }, { spec, silent: true });

    const t = tools as any;
    for (let i = 0; i < 4; i++) await t.update({ id: i });
    const r5 = await t.update({ id: 5 }); // 5th call = trip
    assert.equal(r5.error, true);
    assert.ok(r5.message.includes("calls in last"));
  });
});

// ── Adapter Tests ──────────────────────────────────────────────

describe("anthropic adapter", () => {
  test("wraps and enforces", async () => {
    const enforcer: EnforcerFn = async () => "intercepted";
    const tools = [{ name: "foo", input_schema: { type: "object" }, execute: async () => "real" }];
    const wrapped = wrapAnthropic(tools, enforcer) as any[];
    const result = await wrapped[0].execute({});
    assert.equal(result, "intercepted");
  });

  test("preserves schema", () => {
    const enforcer: EnforcerFn = async (_t, _p, exec) => exec();
    const tools = [{ name: "foo", description: "test", input_schema: { type: "object" }, execute: async () => "real" }];
    const wrapped = wrapAnthropic(tools, enforcer) as any[];
    assert.equal(wrapped[0].name, "foo");
    assert.equal(wrapped[0].description, "test");
  });
});

describe("generic watchTool", () => {
  test("wraps and enforces", async () => {
    const enforcer: EnforcerFn = async () => "intercepted";
    const fn = async (p: Record<string, unknown>) => p;
    const wrapped = watchTool("myTool", fn, enforcer);
    const result = await wrapped({ x: 1 });
    assert.equal(result, "intercepted");
  });

  test("preserves name", () => {
    const enforcer: EnforcerFn = async (_t, _p, exec) => exec();
    const fn = async () => 42;
    const wrapped = watchTool("myTool", fn, enforcer);
    assert.equal(wrapped.name, "myTool");
  });
});

describe("harden detects anthropic tools", () => {
  test("auto-detects anthropic shape", async () => {
    const tools = harden([{ name: "foo", input_schema: {}, execute: async () => 42 }]);
    const result = await (tools as any)[0].execute({});
    assert.equal(result, 42);
  });
});

// ── JSONL Tests ────────────────────────────────────────────────

describe("JSONL", () => {
  test("round-trips events", () => {
    const events = [
      { timestamp: "2026-01-01T00:00:00Z", elapsed: "0.1s", tool: "foo", params: {}, result: "allowed" as const },
      { timestamp: "2026-01-01T00:00:01Z", elapsed: "1.0s", tool: "bar", params: {}, result: "blocked" as const, reason: "denied" },
    ];
    const jsonl = formatJSONL(events, "amr_test");
    const parsed = parseJSONL(jsonl);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]!.tool, "foo");
    assert.equal(parsed[1]!.tool, "bar");
    assert.equal(parsed[1]!.reason, "denied");
  });
});

// ── Backward Compatibility ─────────────────────────────────────

describe("backward compatibility", () => {
  test("harden with no config still works", async () => {
    const tools = harden({ foo: async () => 42 });
    const r = await (tools as any).foo();
    assert.equal(r, 42);
  });

  test("bind still works", async () => {
    const tools = harden({ foo: async (p: any) => p }, { bind: { id: "A" } });
    const r = await (tools as any).foo({ id: "B" });
    assert.equal(r.error, true);
  });

  test("deny still works", async () => {
    const tools = harden({ foo: async () => 1 }, { deny: ["foo"] });
    const r = await (tools as any).foo();
    assert.equal(r.error, true);
  });

  test("shadow mode still works", async () => {
    const tools = harden({ foo: async () => 1 }, { deny: ["foo"], mode: "shadow", silent: true });
    const r = await (tools as any).foo();
    assert.equal(r, 1); // executed despite deny
    const events = (tools as any).__log();
    assert.ok(events.some((e: any) => e.result === "blocked"));
  });

  test("receipt still works", () => {
    const tools = harden({ foo: async () => 1 });
    const receipt = (tools as any).__receipt();
    assert.ok(receipt.includes("AgentMint"));
  });

  test("state still works", () => {
    const tools = harden({ foo: async () => 1 });
    const state = (tools as any).__state();
    assert.ok(state.runId.startsWith("amr_"));
  });
});

// ── Multi-Agent Handoff ────────────────────────────────────────

describe("multi-agent handoff", () => {
  test("cross-ref works across tools in same session", async () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  update_billing:
    requires:
      - lookup_account
    input:
      properties:
        account_id:
          cross_ref: lookup_account.output.account_id
  delete_account:
    action: block
    requires:
      - lookup_account
`);
    const warned: string[] = [];
    const tools = harden({
      lookup_account: async (p: Record<string, unknown>) => ({
        account_id: "ACC-123",
        email: p.email,
      }),
      update_billing: async (p: Record<string, unknown>) => ({
        updated: true,
      }),
      delete_account: async () => ({ deleted: true }),
    }, {
      spec,
      silent: true,
      deny: ["delete_account"],
      onWarn: (_t, _r, d) => { if (d) warned.push(d); },
    });

    const t = tools as any;

    // Lookup returns ACC-123
    await t.lookup_account({ email: "alice@example.com" });

    // Update with WRONG account_id = cross_ref warn
    await t.update_billing({ account_id: "ACC-WRONG", plan: "pro" });
    assert.ok(warned.some((w) => w.includes("ACC-WRONG")));

    // Delete = denied
    const dr = await t.delete_account({});
    assert.equal(dr.error, true);
  });
});

// ── Edge Cases ─────────────────────────────────────────────────

describe("edge cases", () => {
  test("tool throws propagates error", async () => {
    const tools = harden({ boom: async () => { throw new Error("kaboom"); } });
    await assert.rejects(() => (tools as any).boom(), { message: "kaboom" });
  });

  test("tool returns undefined", async () => {
    const tools = harden({ noop: async () => undefined });
    const r = await (tools as any).noop();
    assert.equal(r, undefined);
  });

  test("empty spec (version only) allows everything", async () => {
    const spec = loadSpec(`version: "1.0"`);
    const tools = harden({ anything: async () => 42 }, { spec, silent: true });
    const r = await (tools as any).anything({ dangerous: true });
    assert.equal(r, 42);
  });

  test("spec references tool not in tools object", async () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  nonexistent:
    requires:
      - also_nonexistent
`);
    const tools = harden({ real_tool: async () => 1 }, { spec, silent: true });
    const r = await (tools as any).real_tool({});
    assert.equal(r, 1); // no crash
  });

  test("cross_ref with uncalled tool produces no violation", async () => {
    const spec = loadSpec(`
version: "1.0"
tools:
  refund:
    input:
      properties:
        id:
          cross_ref: never_called.output.id
`);
    const tools = harden({ refund: async () => ({ ok: true }) }, { spec, silent: true });
    const r = await (tools as any).refund({ id: "X" });
    assert.deepEqual(r, { ok: true }); // no violation since never_called has no data
  });
});

console.log("\n  Running integration tests...\n");
