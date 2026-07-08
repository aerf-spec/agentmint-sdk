import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withAgentMint, AgentMintBlockedError } from "./index.js";
import { parseJSONL } from "../../jsonl.js";
import type { VercelToolCallOptions, VercelToolSet } from "./types.js";

// ── A tiny driver that simulates the AI SDK's tool-calling convention:
//    call execute(input, { toolCallId, abortSignal }) in a loop, as
//    generateText would across a multi-step tool loop.
interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  toolCallId: string;
}
async function driveLoop(tools: VercelToolSet, calls: ToolCall[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const call of calls) {
    const tool = tools[call.tool]!;
    const options: VercelToolCallOptions = {
      toolCallId: call.toolCallId,
      messages: [],
    };
    out.push(await (tool.execute as NonNullable<typeof tool.execute>)(call.input, options));
  }
  return out;
}

const refundTools = () => ({
  lookup_order: {
    description: "look up an order",
    execute: vi.fn(
      async (input: { order_id: string }, _options?: VercelToolCallOptions) => ({
        order_id: input.order_id,
        total: 42,
      }),
    ),
  },
  issue_refund: {
    description: "issue a refund",
    execute: vi.fn(
      async (input: { amount: number }, _options?: VercelToolCallOptions) => ({
        refunded: input.amount,
      }),
    ),
  },
});

describe("withAgentMint — run-scoped binding", () => {
  it("one run = one receipt spanning a multi-step tool loop, ordered", async () => {
    const am = withAgentMint();
    const tools = am.tools(refundTools());

    await driveLoop(tools, [
      { tool: "lookup_order", input: { order_id: "ORD-1" }, toolCallId: "c1" },
      { tool: "issue_refund", input: { amount: 42 }, toolCallId: "c2" },
    ]);

    const receipt = am.receipt();
    expect(receipt.summary.calls).toBe(2);
    expect(receipt.summary.executed).toBe(2);
    expect(receipt.events.map((e) => e.tool)).toEqual([
      "lookup_order",
      "issue_refund",
    ]);
    // callRef correlates each receipt line to the exact tool call
    expect(receipt.events.map((e) => e.callRef)).toEqual(["c1", "c2"]);
  });

  it("preserves the input ToolSet's TypeScript type through am.tools()", async () => {
    const am = withAgentMint();
    const input = refundTools();
    const wrapped = am.tools(input);
    // Type-level: keys and execute signatures survive. Exercise them at runtime.
    const r = await wrapped.lookup_order.execute(
      { order_id: "ORD-9" },
      { toolCallId: "c1" },
    );
    expect(r).toEqual({ order_id: "ORD-9", total: 42 });
  });

  it("forwards options (toolCallId, abortSignal) to the underlying tool", async () => {
    const am = withAgentMint();
    const seen = vi.fn();
    const tools = am.tools({
      probe: {
        execute: async (_input: unknown, options: VercelToolCallOptions) => {
          seen(options.toolCallId, options.abortSignal instanceof AbortSignal);
          return "ok";
        },
      },
    });
    const controller = new AbortController();
    await tools.probe.execute!({}, {
      toolCallId: "c_probe",
      abortSignal: controller.signal,
    });
    expect(seen).toHaveBeenCalledWith("c_probe", true);
  });
});

describe("withAgentMint — onStepFinish", () => {
  it("captures step number, model id, usage, finishReason", () => {
    const am = withAgentMint();
    am.onStepFinish({
      stepNumber: 0,
      model: { provider: "test.provider", modelId: "test-model" },
      finishReason: "tool-calls",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      toolCalls: [{ toolCallId: "c1", toolName: "lookup_order" }],
    });
    am.onStepFinish({
      stepNumber: 1,
      model: { provider: "test.provider", modelId: "test-model" },
      finishReason: "stop",
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
    });

    const steps = am.steps();
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      stepNumber: 0,
      model: { modelId: "test-model" },
      finishReason: "tool-calls",
      usage: { totalTokens: 15 },
      toolCallIds: ["c1"],
    });
    expect(steps[1]!.finishReason).toBe("stop");
  });

  it("composes with a user callback via am.onStepFinish(userCallback)", () => {
    const am = withAgentMint();
    const userCb = vi.fn();
    const merged = am.onStepFinish(userCb);

    merged({ stepNumber: 0, finishReason: "stop", model: { modelId: "m" } });

    expect(userCb).toHaveBeenCalledTimes(1);
    expect(am.steps()).toHaveLength(1);
    expect(am.steps()[0]!.model).toEqual({ modelId: "m" });
  });
});

describe("withAgentMint — onBlock policy", () => {
  it('default "return" surfaces a BlockResponse to the model loop', async () => {
    const am = withAgentMint({ deny: ["issue_refund"] });
    const tools = am.tools(refundTools());

    const result = await tools.issue_refund.execute!(
      { amount: 999 },
      { toolCallId: "c_blocked" },
    );
    expect(result).toMatchObject({ error: true, tool: "issue_refund" });
    // the loop can keep going — nothing threw
    expect(am.receipt().summary.blocked).toBe(1);
  });

  it('"throw" raises AgentMintBlockedError on a blocked call', async () => {
    const am = withAgentMint({ deny: ["issue_refund"], onBlock: "throw" });
    const tools = am.tools(refundTools());

    await expect(
      tools.issue_refund.execute!({ amount: 999 }, { toolCallId: "c_throw" }),
    ).rejects.toBeInstanceOf(AgentMintBlockedError);
    // the block is still recorded on the receipt
    expect(am.receipt().summary.blocked).toBe(1);
  });

  it('"throw" still lets allowed calls through', async () => {
    const am = withAgentMint({ deny: ["issue_refund"], onBlock: "throw" });
    const tools = am.tools(refundTools());
    const r = await tools.lookup_order.execute!(
      { order_id: "ORD-1" },
      { toolCallId: "c_ok" },
    );
    expect(r).toMatchObject({ order_id: "ORD-1" });
  });
});

describe("withAgentMint — concurrency isolation", () => {
  it("two interleaved runs never share state", async () => {
    const a = withAgentMint({ deny: ["issue_refund"] });
    const b = withAgentMint(); // no deny
    const toolsA = a.tools(refundTools());
    const toolsB = b.tools(refundTools());

    // interleave calls across the two runs
    await toolsA.lookup_order.execute!({ order_id: "A1" }, { toolCallId: "a1" });
    await toolsB.lookup_order.execute!({ order_id: "B1" }, { toolCallId: "b1" });
    await toolsA.issue_refund.execute!({ amount: 1 }, { toolCallId: "a2" }); // blocked in A
    await toolsB.issue_refund.execute!({ amount: 2 }, { toolCallId: "b2" }); // allowed in B

    const ra = a.receipt();
    const rb = b.receipt();
    expect(a.runId).not.toBe(b.runId);
    expect(ra.summary.blocked).toBe(1);
    expect(ra.summary.executed).toBe(1);
    expect(rb.summary.blocked).toBe(0);
    expect(rb.summary.executed).toBe(2);
    // events don't bleed across runs
    expect(ra.events.map((e) => e.callRef)).toEqual(["a1", "a2"]);
    expect(rb.events.map((e) => e.callRef)).toEqual(["b1", "b2"]);
  });
});

describe("withAgentMint — receipt output", () => {
  it("writeJSONL writes one line per event, with callRef", async () => {
    const am = withAgentMint();
    const tools = am.tools(refundTools());
    await driveLoop(tools, [
      { tool: "lookup_order", input: { order_id: "ORD-1" }, toolCallId: "c1" },
    ]);

    const dir = mkdtempSync(join(tmpdir(), "am-vercel-"));
    try {
      const path = join(dir, "nested", "run.jsonl");
      am.writeJSONL(path);
      const lines = parseJSONL(readFileSync(path, "utf-8"));
      expect(lines).toHaveLength(1);
      expect(lines[0]!.tool).toBe("lookup_order");
      expect((lines[0] as { callRef?: string }).callRef).toBe("c1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("receipt() is a standard AERFRecord (verify()-compatible shape)", async () => {
    const am = withAgentMint();
    am.tools(refundTools());
    const receipt = am.receipt();
    expect(receipt.version).toBe("0.1.0");
    expect(receipt.status).toBe("completed");
    expect(typeof receipt.runId).toBe("string");
  });
});
