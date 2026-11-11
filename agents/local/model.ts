// Model access over any OpenAI-compatible /chat/completions endpoint with tool calling
// (LM Studio, Ollama, vLLM, llama.cpp server, hosted). The scripted mock lives in mock-model.ts.

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Reasoning fields some servers return on assistant messages. */
  reasoning_content?: string;
  reasoning?: string;
}

export interface Completion {
  request_id?: string;
  /** The raw assistant message as the server returned it. */
  message: ChatMessage;
  finish_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
  /** "native" when the server parsed tool calls, "text" when we recovered them from the content. */
  tool_call_source: "native" | "text" | "none";
}

export interface ChatModel {
  readonly name: string;
  complete(messages: ChatMessage[], tools: unknown[]): Promise<Completion>;
}

export interface OpenAIOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

let textCallSeq = 0;

/**
 * Some servers pass Hermes/Qwen-style tool calls through as text instead of parsing them:
 * `<tool_call>{"name": ..., "arguments": {...}}</tool_call>`. Recover them so the run still works.
 */
export function toolCallsFromText(content: string): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = [];
  const rest = content.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (m, json: string) => {
    try {
      const o = JSON.parse(json) as { name?: unknown; arguments?: unknown };
      if (typeof o.name !== "string") return m;
      const args = typeof o.arguments === "string" ? o.arguments : JSON.stringify(o.arguments ?? {});
      calls.push({ id: `text_call_${++textCallSeq}`, type: "function", function: { name: o.name, arguments: args } });
      return "";
    } catch {
      return m;
    }
  });
  return { calls, rest: rest.trim() };
}

export class OpenAICompatModel implements ChatModel {
  readonly name: string;
  constructor(private opts: OpenAIOptions) {
    this.name = opts.model;
  }

  async complete(messages: ChatMessage[], tools: unknown[]): Promise<Completion> {
    const url = this.opts.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages,
        tools,
        tool_choice: "auto",
        temperature: this.opts.temperature ?? 0.2,
        ...(this.opts.maxTokens ? { max_tokens: this.opts.maxTokens } : {}),
        stream: false,
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 600_000),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${url} → ${r.status}: ${text.slice(0, 500)}`);
    const j = JSON.parse(text) as {
      id?: string;
      choices?: { message?: ChatMessage; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = j.choices?.[0];
    if (!choice?.message) throw new Error(`${url}: no choices in response`);
    const message: ChatMessage = { ...choice.message, role: "assistant", content: choice.message.content ?? null };
    let source: Completion["tool_call_source"] = message.tool_calls?.length ? "native" : "none";
    if (source === "none" && typeof message.content === "string" && message.content.includes("<tool_call>")) {
      const { calls, rest } = toolCallsFromText(message.content);
      if (calls.length) {
        message.tool_calls = calls;
        message.content = rest;
        source = "text";
      }
    }
    return {
      request_id: j.id,
      message,
      finish_reason: choice.finish_reason ?? (message.tool_calls?.length ? "tool_calls" : "stop"),
      usage: j.usage ? { input_tokens: j.usage.prompt_tokens ?? 0, output_tokens: j.usage.completion_tokens ?? 0 } : undefined,
      tool_call_source: source,
    };
  }
}
