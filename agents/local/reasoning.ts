// Pull a model's reasoning out of an OpenAI-compatible chat-completions message.
//
// Servers expose it in different places:
//   reasoning_content  LM Studio (separate-reasoning setting), DeepSeek API, vLLM reasoning parsers
//                      (DeepSeek-R1, Qwen3, gpt-oss)
//   reasoning          Ollama /v1, OpenRouter, newer vLLM
//   <think>…</think>   inline in content when the server does not split it out (R1 distills, Qwen3,
//                      QwQ, MedGemma-style templates). Also handles a closing tag with no opener
//                      (chat template already emitted "<think>") and an opener with no closer
//                      (output cut off at max_tokens).
// The method that found it is recorded so runs across models can be compared.

export type ReasoningMethod = "reasoning_content" | "reasoning" | "think_tag" | "none";

export interface Extracted {
  /** Raw reasoning text. Private: stays on this machine. */
  thinking: string;
  /** Content with every think block removed: what the caller hears. */
  content: string;
  /** Where the reasoning came from, e.g. "reasoning_content", "think_tag", "reasoning_content+think_tag". */
  method: string;
}

const OPEN = /<(think|thinking|reasoning)>/i;
const CLOSE = /<\/(think|thinking|reasoning)>/i;
const BLOCK = /<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/gi;

/** Split inline think tags out of text. */
export function splitThinkTags(text: string): { thinking: string[]; content: string } {
  const thinking: string[] = [];
  let rest = text;
  // Closing tag before any opener: everything up to it is reasoning.
  const close = CLOSE.exec(rest);
  const open = OPEN.exec(rest);
  if (close && (!open || close.index < open.index)) {
    thinking.push(rest.slice(0, close.index));
    rest = rest.slice(close.index + close[0].length);
  }
  rest = rest.replace(BLOCK, (_m, _tag: string, inner: string) => {
    thinking.push(inner);
    return "";
  });
  // Opener with no closer: the rest is unfinished reasoning.
  const dangling = OPEN.exec(rest);
  if (dangling) {
    thinking.push(rest.slice(dangling.index + dangling[0].length));
    rest = rest.slice(0, dangling.index);
  }
  return { thinking: thinking.map((t) => t.trim()).filter(Boolean), content: rest.trim() };
}

export function extractReasoning(message: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }): Extracted {
  const parts: string[] = [];
  const methods: ReasoningMethod[] = [];
  const field = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  const rc = field(message.reasoning_content);
  if (rc) { parts.push(rc); methods.push("reasoning_content"); }
  const r = field(message.reasoning);
  if (r && r !== rc) { parts.push(r); methods.push("reasoning"); }

  const raw = typeof message.content === "string" ? message.content : "";
  const split = splitThinkTags(raw);
  if (split.thinking.length) { parts.push(...split.thinking); methods.push("think_tag"); }

  return { thinking: parts.join("\n\n"), content: split.content, method: methods.length ? methods.join("+") : "none" };
}
