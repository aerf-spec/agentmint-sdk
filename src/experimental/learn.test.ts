import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inferSpec, mergeSpecs, serializeSpec, generateTestFile } from "./learn.js";
import { loadSpec } from "../kernel/spec.js";
import { harden } from "./harden.js";
import type { JSONLEvent, RunState } from "../types.js";

function ev(partial: Partial<JSONLEvent> & { tool: string; result: string }): JSONLEvent {
  return {
    timestamp: "2026-07-01T00:00:00.000Z",
    runId: "amr_test",
    ...partial,
  };
}

describe("inferSpec", () => {
  it("empty events → version-only spec", () => {
    expect(inferSpec([])).toEqual({ version: "1.0" });
  });

  it("single requires violation → requires rule", () => {
    const spec = inferSpec([
      ev({
        tool: "issue_refund",
        result: "blocked",
        reason: "requires",
        details: '"lookup_order" must be called before "issue_refund"',
      }),
    ]);
    expect(spec.tools?.issue_refund?.requires).toEqual(["lookup_order"]);
  });

  it("single cross_ref violation → cross_ref rule", () => {
    const spec = inferSpec([
      ev({
        tool: "issue_refund",
        result: "warned",
        reason: "cross_ref",
        details: 'order_id: expected "ORD-100" (from lookup_order.input.order_id), got "ORD-999"',
      }),
    ]);
    expect(spec.tools?.issue_refund?.input?.properties?.order_id?.cross_ref).toBe(
      "lookup_order.input.order_id",
    );
  });

  it("single max_ref violation → max_ref rule", () => {
    const spec = inferSpec([
      ev({
        tool: "issue_refund",
        result: "warned",
        reason: "max_ref",
        details: "amount: 200 exceeds max 49.99 (from lookup_order.output.total)",
      }),
    ]);
    expect(spec.tools?.issue_refund?.input?.properties?.amount?.max_ref).toBe(
      "lookup_order.output.total",
    );
  });

  it("loop breaker trip → breaker config", () => {
    const spec = inferSpec([
      ev({
        tool: "run_tests",
        result: "blocked",
        reason: "loop_breaker",
        details: "run_tests called 3 times with identical args (limit: 3)",
      }),
    ]);
    expect(spec.breakers?.loop?.max_identical_calls).toBe(3);
    expect(spec.breakers?.loop?.action).toBe("block");
  });

  it("velocity breaker trip → breaker config", () => {
    const spec = inferSpec([
      ev({
        tool: "check_eligibility",
        result: "blocked",
        reason: "velocity_breaker",
        details: "13 calls in last 30s (limit: 12)",
      }),
    ]);
    expect(spec.breakers?.velocity?.max_calls_per_window).toBe(12);
    expect(spec.breakers?.velocity?.window_seconds).toBe(30);
  });

  it("multiple violations across tools → all tools covered", () => {
    const spec = inferSpec([
      ev({
        tool: "issue_refund",
        result: "blocked",
        reason: "requires",
        details: '"lookup_order" must be called before "issue_refund"',
      }),
      ev({
        tool: "git_push",
        result: "blocked",
        reason: "blocked_value",
        details: 'branch has blocked value "main"',
      }),
    ]);
    expect(Object.keys(spec.tools ?? {}).sort()).toEqual(["git_push", "issue_refund"]);
    expect(spec.tools?.git_push?.input?.properties?.branch?.blocked_values).toEqual(["main"]);
  });

  it("duplicate violations → deduplicated", () => {
    const violation = ev({
      tool: "issue_refund",
      result: "blocked",
      reason: "requires",
      details: '"lookup_order" must be called before "issue_refund"',
    });
    const spec = inferSpec([violation, { ...violation }]);
    expect(spec.tools?.issue_refund?.requires).toEqual(["lookup_order"]);
  });
});

describe("serializeSpec", () => {
  it("round-trips through loadSpec identically", () => {
    const spec = inferSpec([
      ev({
        tool: "issue_refund",
        result: "blocked",
        reason: "requires",
        details: '"lookup_order" must be called before "issue_refund"',
      }),
      ev({
        tool: "issue_refund",
        result: "warned",
        reason: "cross_ref",
        details: 'order_id: expected "ORD-100" (from lookup_order.input.order_id), got "ORD-999"',
      }),
      ev({
        tool: "run_command",
        result: "blocked",
        reason: "blocked_pattern",
        details: 'command contains blocked pattern "rm -rf"',
      }),
      ev({
        tool: "git_push",
        result: "blocked",
        reason: "blocked_value",
        details: 'branch has blocked value "main"',
      }),
      ev({
        tool: "run_tests",
        result: "blocked",
        reason: "loop_breaker",
        details: "run_tests called 3 times with identical args (limit: 3)",
      }),
    ]);
    const roundTripped = loadSpec(serializeSpec(spec));
    expect(roundTripped).toEqual(spec);
  });
});

describe("mergeSpecs", () => {
  it("preserves existing rules and adds new ones", () => {
    const existing = loadSpec(`
version: "1.0"
tools:
  issue_refund:
    requires:
      - lookup_order
`);
    const inferred = inferSpec([
      ev({
        tool: "git_push",
        result: "blocked",
        reason: "blocked_value",
        details: 'branch has blocked value "main"',
      }),
    ]);
    const merged = mergeSpecs(existing, inferred);
    expect(merged.tools?.issue_refund?.requires).toEqual(["lookup_order"]);
    expect(merged.tools?.git_push?.input?.properties?.branch?.blocked_values).toEqual(["main"]);
  });
});

describe("generateTestFile", () => {
  it("generates a regression suite that runs green under vitest (exit 0)", () => {
    // Two reproducible violations (requires with no prior call; blocked_value)
    // plus an allowed call. Both violations re-fire on replay with no prereqs.
    const events: JSONLEvent[] = [
      ev({
        tool: "issue_refund",
        result: "blocked",
        reason: "requires",
        details: '"lookup_order" must be called before "issue_refund"',
        params: { amount: 10 },
      }),
      ev({
        tool: "charge_card",
        result: "blocked",
        reason: "blocked_value",
        details: 'currency has blocked value "XXX"',
        params: { currency: "XXX" },
      }),
      ev({ tool: "read_report", result: "allowed", params: { id: "R1" } }),
    ];
    const spec = inferSpec(events);

    const dir = mkdtempSync(join(tmpdir(), "learn-gen-"));
    const testFile = join(dir, "policy.test.ts");
    const sdkEntry = fileURLToPath(new URL("../index.ts", import.meta.url));

    const content = generateTestFile({
      events,
      spec,
      fromPath: "fixture.jsonl",
      testPath: testFile,
      timestamp: "2026-07-02T00:00:00.000Z",
      importSpecifier: sdkEntry,
    });
    writeFileSync(testFile, content, "utf-8");

    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    let status = 0;
    try {
      execFileSync("npx", ["vitest", "run", "--root", dir, testFile], {
        cwd: repoRoot,
        stdio: "pipe",
      });
    } catch (err) {
      status = (err as { status?: number }).status ?? 1;
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(
        `generated test failed (exit ${status}):\n${e.stdout?.toString() ?? ""}\n${e.stderr?.toString() ?? ""}`,
      );
    }
    expect(status).toBe(0);
  }, 30_000);
});

describe("round-trip enforcement", () => {
  it("a spec learned from a violation catches that violation again", async () => {
    const spec = inferSpec([
      ev({
        tool: "issue_refund",
        result: "blocked",
        reason: "requires",
        details: '"lookup_order" must be called before "issue_refund"',
      }),
    ]);
    const loaded = loadSpec(serializeSpec(spec));

    const tools = harden(
      {
        lookup_order: async () => ({ total: 49.99 }),
        issue_refund: async () => ({ ok: true }),
      },
      { spec: loaded, silent: true },
    );

    await (tools as Record<string, Function>).issue_refund!({ order_id: "ORD-1", amount: 10 });
    const state = (tools as unknown as { __state(): RunState }).__state();
    expect(state.blockedCount).toBeGreaterThan(0);
  });
});
