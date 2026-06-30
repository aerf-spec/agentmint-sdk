import { describe, expect, it } from "vitest";
import { checkBreakers } from "./breakers.js";
import { createSession, hashArgs, recordInput } from "./session.js";
import type { SessionStore } from "./types.js";

/** Push a synthetic call-history entry with an explicit timestamp. */
function pushCall(s: SessionStore, tool: string, args: Record<string, unknown>, timestamp: number): void {
  s.callHistory.push({ tool, timestamp, args, argsHash: hashArgs(tool, args) });
}

describe("loop breaker", () => {
  it("trips once identical-call count reaches the limit", () => {
    const s = createSession();
    recordInput(s, "query_db", { sql: "SELECT 1" });
    recordInput(s, "query_db", { sql: "SELECT 1" });
    recordInput(s, "query_db", { sql: "SELECT 1" });
    const v = checkBreakers("query_db", { sql: "SELECT 1" }, s, { loop: { max_identical_calls: 3 } }, 0);
    expect(v).toHaveLength(1);
    expect(v[0]!.type).toBe("loop_breaker");
  });

  it("passes below the limit", () => {
    const s = createSession();
    recordInput(s, "query_db", { sql: "SELECT 1" });
    recordInput(s, "query_db", { sql: "SELECT 1" });
    const v = checkBreakers("query_db", { sql: "SELECT 1" }, s, { loop: { max_identical_calls: 3 } }, 0);
    expect(v).toHaveLength(0);
  });

  it("ignores calls with different args", () => {
    const s = createSession();
    recordInput(s, "query_db", { sql: "SELECT 1" });
    recordInput(s, "query_db", { sql: "SELECT 1" });
    recordInput(s, "query_db", { sql: "SELECT 2" });
    const v = checkBreakers("query_db", { sql: "SELECT 2" }, s, { loop: { max_identical_calls: 3 } }, 0);
    expect(v).toHaveLength(0);
  });
});

describe("velocity breaker", () => {
  it("trips when recent calls reach the limit", () => {
    const s = createSession();
    const now = Date.now();
    for (let i = 0; i < 5; i++) pushCall(s, "update", { id: i }, now);
    const v = checkBreakers(
      "update",
      { id: 99 },
      s,
      { velocity: { max_calls_per_window: 5, window_seconds: 30 } },
      0,
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.type).toBe("velocity_breaker");
  });

  it("passes below the limit", () => {
    const s = createSession();
    const now = Date.now();
    for (let i = 0; i < 2; i++) pushCall(s, "update", { id: i }, now);
    const v = checkBreakers(
      "update",
      { id: 99 },
      s,
      { velocity: { max_calls_per_window: 5, window_seconds: 30 } },
      0,
    );
    expect(v).toHaveLength(0);
  });

  it("respects the time window (ignores calls outside it)", () => {
    const s = createSession();
    const old = Date.now() - 60_000; // 60s ago, outside a 30s window
    for (let i = 0; i < 10; i++) pushCall(s, "update", { id: i }, old);
    const v = checkBreakers(
      "update",
      { id: 99 },
      s,
      { velocity: { max_calls_per_window: 5, window_seconds: 30 } },
      0,
    );
    expect(v).toHaveLength(0);
  });
});

describe("cost breaker", () => {
  it("trips when total cost reaches the limit", () => {
    const s = createSession();
    const v = checkBreakers("expensive", {}, s, { cost: { max_usd: 10 } }, 10);
    expect(v).toHaveLength(1);
    expect(v[0]!.type).toBe("cost_breaker");
  });

  it("passes under the limit", () => {
    const s = createSession();
    const v = checkBreakers("expensive", {}, s, { cost: { max_usd: 10 } }, 4.99);
    expect(v).toHaveLength(0);
  });
});

describe("breaker defaults", () => {
  it("defaults every breaker action to block", () => {
    const s = createSession();
    recordInput(s, "loop_t", { a: 1 });
    const loopV = checkBreakers("loop_t", { a: 1 }, s, { loop: { max_identical_calls: 1 } }, 0);
    expect(loopV[0]!.action).toBe("block");

    const now = Date.now();
    pushCall(s, "vel_t", {}, now);
    const velV = checkBreakers("vel_t", {}, s, { velocity: { max_calls_per_window: 1, window_seconds: 30 } }, 0);
    expect(velV[0]!.action).toBe("block");

    const costV = checkBreakers("cost_t", {}, s, { cost: { max_usd: 1 } }, 5);
    expect(costV[0]!.action).toBe("block");
  });

  it("returns no violations when breakers config is undefined", () => {
    const s = createSession();
    expect(checkBreakers("x", {}, s, undefined, 100)).toHaveLength(0);
  });
});
