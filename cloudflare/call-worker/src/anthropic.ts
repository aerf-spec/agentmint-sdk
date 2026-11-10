// Raw-fetch streaming client for POST /v1/messages (Workers runtime).
// Accumulates content blocks exactly as returned (thinking text + signature,
// text, tool_use input JSON) so they can be passed back unchanged.

export type Block = Record<string, unknown> & { type: string };

export interface StreamHandlers {
  onThinking?(index: number, delta: string): void;
  onText?(index: number, delta: string): void;
  onBlockStop?(index: number, block: Block): void;
  onHeaders?(requestId: string | null): void;
}

export interface StreamResult {
  content: Block[];
  stop_reason: string | null;
  stop_details: unknown;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
  request_id: string | null;
  message_id: string | null;
  model: string | null;
  ms: number;
  ttfb_ms: number;
}

export class AnthropicError extends Error {
  /** Usage seen before the failure (e.g. an aborted stream still bills its input). */
  usage?: StreamResult["usage"];
  model?: string | null;
  constructor(readonly status: number, message: string, readonly requestId: string | null, readonly retryable: boolean, readonly interrupted = false) {
    super(message);
  }
}

export async function streamMessage(apiKey: string, body: Record<string, unknown>, h: StreamHandlers, timeoutMs: number, signal?: AbortSignal): Promise<StreamResult> {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => ac.abort(new Error("interrupted"));
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort);
  const why = () => (signal?.aborted ? "interrupted" : `timeout after ${timeoutMs} ms`);
  let requestId: string | null = null;
  let partial: StreamResult | undefined;
  try {
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: ac.signal,
      });
    } catch (e) {
      throw new AnthropicError(0, ac.signal.aborted ? why() : `network: ${(e as Error).message}`, null, !signal?.aborted, !!signal?.aborted);
    }
    requestId = res.headers.get("request-id");
    h.onHeaders?.(requestId);
    const ttfb = Date.now() - t0;
    if (!res.ok || !res.body) {
      const text = (await res.text().catch(() => "")).slice(0, 500);
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
      throw new AnthropicError(res.status, `HTTP ${res.status}: ${text}`, requestId, retryable);
    }

    const content: Block[] = [];
    const partialJson = new Map<number, string>();
    const out: StreamResult = {
      content,
      stop_reason: null,
      stop_details: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      request_id: requestId,
      message_id: null,
      model: null,
      ms: 0,
      ttfb_ms: ttfb,
    };
    partial = out;

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    let done = false;
    while (!done) {
      let r: ReadableStreamReadResult<string>;
      try {
        r = await reader.read();
      } catch (e) {
        throw new AnthropicError(0, ac.signal.aborted ? why() : `stream: ${(e as Error).message}`, requestId, !signal?.aborted, !!signal?.aborted);
      }
      if (r.done) break;
      buf += r.value;
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let data = "";
        for (const line of raw.split("\n")) if (line.startsWith("data:")) data += line.slice(5).trimStart();
        if (!data) continue;
        const ev = JSON.parse(data) as Record<string, any>;
        switch (ev.type) {
          case "message_start": {
            const m = ev.message ?? {};
            out.message_id = m.id ?? null;
            out.model = m.model ?? null;
            Object.assign(out.usage, pickUsage(m.usage));
            break;
          }
          case "content_block_start": {
            const b = { ...(ev.content_block as Block) };
            if (b.type === "tool_use") partialJson.set(ev.index, "");
            content[ev.index] = b;
            break;
          }
          case "content_block_delta": {
            const b = content[ev.index]!;
            const d = ev.delta ?? {};
            if (d.type === "thinking_delta") {
              b.thinking = String(b.thinking ?? "") + d.thinking;
              h.onThinking?.(ev.index, d.thinking);
            } else if (d.type === "signature_delta") {
              b.signature = d.signature;
            } else if (d.type === "text_delta") {
              b.text = String(b.text ?? "") + d.text;
              h.onText?.(ev.index, d.text);
            } else if (d.type === "input_json_delta") {
              partialJson.set(ev.index, (partialJson.get(ev.index) ?? "") + d.partial_json);
            }
            break;
          }
          case "content_block_stop": {
            const b = content[ev.index]!;
            if (b.type === "tool_use") {
              const pj = partialJson.get(ev.index) ?? "";
              try {
                b.input = pj ? JSON.parse(pj) : {};
              } catch {
                b.input = { __invalid_json: true };
              }
            }
            h.onBlockStop?.(ev.index, b);
            break;
          }
          case "message_delta":
            out.stop_reason = ev.delta?.stop_reason ?? out.stop_reason;
            out.stop_details = ev.delta?.stop_details ?? null;
            Object.assign(out.usage, pickUsage(ev.usage));
            break;
          case "message_stop":
            done = true;
            break;
          case "error":
            throw new AnthropicError(0, `stream error: ${ev.error?.type ?? "unknown"}`, requestId, ev.error?.type === "overloaded_error" || ev.error?.type === "api_error");
        }
      }
    }
    out.ms = Date.now() - t0;
    return out;
  } catch (e) {
    if (e instanceof AnthropicError && partial) {
      e.usage = partial.usage;
      e.model = partial.model;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function pickUsage(u: Record<string, unknown> | undefined): Partial<StreamResult["usage"]> {
  const o: Partial<StreamResult["usage"]> = {};
  if (!u) return o;
  for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
    if (typeof u[k] === "number") o[k] = u[k] as number;
  }
  return o;
}
