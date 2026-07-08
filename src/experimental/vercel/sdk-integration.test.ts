/**
 * Integration test: drive a real AI SDK `generateText` multi-step tool loop
 * against AgentMint-wrapped tools using `MockLanguageModelV3` (no API key).
 * This file imports `ai` — allowed because tests are dev-only. Shipped runtime
 * code never imports `ai`.
 */
import { describe, expect, it } from "vitest";
import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import * as z from "zod";
import { withAgentMint } from "./index.js";
import type { LanguageModelV3Usage } from "@ai-sdk/provider";

const usage = (): LanguageModelV3Usage => ({
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
});

describe("withAgentMint × generateText (MockLanguageModelV3)", () => {
  it("records a receipt across a real two-step tool loop", async () => {
    // Step 1: model calls lookup_order. Step 2: model calls issue_refund.
    // Step 3: model emits final text and stops.
    const model = new MockLanguageModelV3({
      modelId: "mock-model",
      provider: "mock.provider",
      doGenerate: [
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_lookup",
              toolName: "lookup_order",
              input: JSON.stringify({ order_id: "ORD-1" }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: usage(),
          warnings: [],
        },
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_refund",
              toolName: "issue_refund",
              input: JSON.stringify({ amount: 42 }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: usage(),
          warnings: [],
        },
        {
          content: [{ type: "text", text: "Refund issued." }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: usage(),
          warnings: [],
        },
      ],
    });

    const am = withAgentMint();

    const result = await generateText({
      model,
      tools: am.tools({
        lookup_order: tool({
          description: "look up an order",
          inputSchema: z.object({ order_id: z.string() }),
          execute: async ({ order_id }) => ({ order_id, total: 42 }),
        }),
        issue_refund: tool({
          description: "issue a refund",
          inputSchema: z.object({ amount: z.number() }),
          execute: async ({ amount }) => ({ refunded: amount }),
        }),
      }),
      stopWhen: stepCountIs(5),
      onStepFinish: am.onStepFinish,
      prompt: "Refund order ORD-1.",
    });

    expect(result.text).toBe("Refund issued.");

    // One receipt for the whole run, both tool calls in order, correlated by
    // the AI SDK's toolCallId.
    const receipt = am.receipt();
    expect(receipt.events.map((e) => e.tool)).toEqual([
      "lookup_order",
      "issue_refund",
    ]);
    expect(receipt.events.map((e) => e.callRef)).toEqual([
      "call_lookup",
      "call_refund",
    ]);
    expect(receipt.summary.executed).toBe(2);

    // onStepFinish captured model id + usage for each step.
    const steps = am.steps();
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps[0]!.model?.modelId).toBe("mock-model");
    expect(steps[0]!.usage?.totalTokens).toBe(15);
  });

  it("a blocked tool returns a denial the loop can continue past", async () => {
    const model = new MockLanguageModelV3({
      modelId: "mock-model",
      provider: "mock.provider",
      doGenerate: [
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_refund",
              toolName: "issue_refund",
              input: JSON.stringify({ amount: 999 }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: usage(),
          warnings: [],
        },
        {
          content: [{ type: "text", text: "I can't issue that refund." }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: usage(),
          warnings: [],
        },
      ],
    });

    const am = withAgentMint({ deny: ["issue_refund"] });

    const result = await generateText({
      model,
      tools: am.tools({
        issue_refund: tool({
          description: "issue a refund",
          inputSchema: z.object({ amount: z.number() }),
          execute: async ({ amount }) => ({ refunded: amount }),
        }),
      }),
      stopWhen: stepCountIs(5),
      prompt: "Refund $999.",
    });

    // The loop ran to a natural stop, and the block is on the receipt.
    expect(result.text).toBe("I can't issue that refund.");
    const receipt = am.receipt();
    expect(receipt.summary.blocked).toBe(1);
    expect(receipt.events[0]!.result).toBe("blocked");
    expect(receipt.events[0]!.callRef).toBe("call_refund");
  });
});
