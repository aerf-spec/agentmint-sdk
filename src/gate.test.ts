import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import { gate } from "./gate.js";
import { harden } from "./harden.js";
import { loadSpec } from "./spec.js";
import type { RunState } from "./types.js";

/** A readable stream that yields `line` then ends. */
function stdinLine(line: string): Readable {
  return Readable.from([line + "\n"]);
}

/** A readable stream that never emits — used to force the TTL timeout. */
function silentStdin(): Readable {
  return new PassThrough();
}

/** Discard the rendered approval box. */
function sink(): NodeJS.WritableStream {
  return new PassThrough();
}

describe("gate — console channel", () => {
  it('"y" → approved', async () => {
    const r = await gate({
      action: "deploy",
      context: { env: "prod" },
      input: stdinLine("y"),
      output: sink(),
    });
    expect(r.approved).toBe(true);
  });

  it('"n" → rejected with no reason', async () => {
    const r = await gate({
      action: "deploy",
      context: {},
      input: stdinLine("n"),
      output: sink(),
    });
    expect(r.approved).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it("free-text → rejected with reason captured", async () => {
    const r = await gate({
      action: "deploy",
      context: {},
      input: stdinLine("bad data quality"),
      output: sink(),
    });
    expect(r.approved).toBe(false);
    expect(r.reason).toBe("bad data quality");
  });

  it("TTL expiry → auto-deny with reason 'timeout'", async () => {
    const r = await gate({
      action: "deploy",
      context: {},
      ttl: 0.05,
      input: silentStdin(),
      output: sink(),
    });
    expect(r.approved).toBe(false);
    expect(r.reason).toBe("timeout");
  });

  it("result carries a non-empty hash", async () => {
    const r = await gate({
      action: "x",
      context: {},
      input: stdinLine("y"),
      output: sink(),
    });
    expect(typeof r.hash).toBe("string");
    expect(r.hash.length).toBeGreaterThan(0);
  });

  it("sequential gates produce different, chained hashes", async () => {
    const a = await gate({ action: "a", context: {}, input: stdinLine("y"), output: sink() });
    const b = await gate({ action: "b", context: {}, input: stdinLine("y"), output: sink() });
    expect(a.hash).not.toBe(b.hash);
  });

  it("preserves action and context on the result", async () => {
    const context = { table: "users", count: 4200 };
    const r = await gate({
      action: "delete_records",
      context,
      input: stdinLine("y"),
      output: sink(),
    });
    expect(r.action).toBe("delete_records");
    expect(r.context).toEqual(context);
  });

  it("works standalone via the positional signature", async () => {
    const r = await gate(
      "deploy",
      { env: "staging" },
      { input: stdinLine("y"), output: sink() },
    );
    expect(r.approved).toBe(true);
    expect(r.context).toEqual({ env: "staging" });
  });

  it("records a duration and a timestamp", async () => {
    const r = await gate({ action: "x", context: {}, input: stdinLine("y"), output: sink() });
    expect(r.timestamp).toBeGreaterThan(0);
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("gate — slack channel", () => {
  it("throws a clear error when no webhook is configured", async () => {
    const saved = process.env.AGENTMINT_SLACK_WEBHOOK;
    delete process.env.AGENTMINT_SLACK_WEBHOOK;
    try {
      await expect(
        gate({ action: "x", context: {}, channel: "slack", output: sink() }),
      ).rejects.toThrow(/AGENTMINT_SLACK_WEBHOOK/);
    } finally {
      if (saved !== undefined) process.env.AGENTMINT_SLACK_WEBHOOK = saved;
    }
  });
});

describe("gate — harden() checkpoint integration", () => {
  it("a checkpoint tool triggers gate and rejects on timeout", async () => {
    const tools = harden(
      {
        deploy: async () => ({ ok: true }),
      },
      {
        spec: loadSpec("version: \"1.0\""),
        checkpoint: ["deploy"],
        gate: { channel: "console", ttl: 0.05 },
        silent: true,
      },
    );

    const res = await (tools as Record<string, Function>).deploy!({ env: "prod" });
    expect((res as { error?: boolean }).error).toBe(true);

    const state = (tools as unknown as { __state(): RunState }).__state();
    expect(state.blockedCount).toBeGreaterThan(0);
    const rejected = state.events.find((e) => e.result === "rejected");
    expect(rejected?.reason).toBe("gate_rejected");
    expect(rejected?.details).toBe("timeout");
    // ensure the checkpoint was actually held before gating
    expect(state.heldCount).toBeGreaterThan(0);
  });
});
