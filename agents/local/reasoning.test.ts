import { describe, expect, it } from "vitest";
import { extractReasoning, splitThinkTags } from "./reasoning.js";
import { toolCallsFromText } from "./model.js";

describe("extractReasoning", () => {
  it("reads reasoning_content (LM Studio / DeepSeek)", () => {
    const e = extractReasoning({ content: "Three visits left.", reasoning_content: "limit 20, used 17" });
    expect(e).toEqual({ thinking: "limit 20, used 17", content: "Three visits left.", method: "reasoning_content" });
  });

  it("reads reasoning (Ollama / OpenRouter)", () => {
    const e = extractReasoning({ content: "Hi.", reasoning: "greet them" });
    expect(e.method).toBe("reasoning");
    expect(e.thinking).toBe("greet them");
  });

  it("splits <think> blocks out of content", () => {
    const e = extractReasoning({ content: "<think>\ncheck the DOB first\n</think>\n\nWhat's your date of birth?" });
    expect(e).toEqual({ thinking: "check the DOB first", content: "What's your date of birth?", method: "think_tag" });
  });

  it("handles a closing tag with no opener (template already emitted <think>)", () => {
    const e = extractReasoning({ content: "plan: look up benefits</think>Let me check." });
    expect(e.thinking).toBe("plan: look up benefits");
    expect(e.content).toBe("Let me check.");
  });

  it("handles an opener with no closer (cut off at max_tokens)", () => {
    const e = extractReasoning({ content: "Okay. <think>still reasoning about" });
    expect(e.thinking).toBe("still reasoning about");
    expect(e.content).toBe("Okay.");
  });

  it("joins several blocks and records both methods", () => {
    const e = extractReasoning({ content: "<think>a</think>x<thinking>b</thinking>y", reasoning_content: "r" });
    expect(e.thinking).toBe("r\n\na\n\nb");
    expect(e.content).toBe("xy");
    expect(e.method).toBe("reasoning_content+think_tag");
  });

  it("returns none when there is no reasoning", () => {
    expect(extractReasoning({ content: null })).toEqual({ thinking: "", content: "", method: "none" });
    expect(splitThinkTags("plain").thinking).toEqual([]);
  });

  it("recovers Hermes-style <tool_call> text", () => {
    const { calls, rest } = toolCallsFromText('Sure. <tool_call>{"name":"lookup_benefits","arguments":{"year":2026}}</tool_call>');
    expect(rest).toBe("Sure.");
    expect(calls[0]?.function).toEqual({ name: "lookup_benefits", arguments: '{"year":2026}' });
  });
});
