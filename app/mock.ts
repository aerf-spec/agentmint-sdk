// Mock model provider and downstream services, so the demo runs with no API
// keys. The provider returns Anthropic-shaped message objects and keeps its
// own request log (like a provider usage export) for reconciliation.
import { randomBytes } from "node:crypto";

export type Wait = (ms: number) => Promise<void>;

export interface MockResponse {
  thinking: string;
  say: string;
  tool?: { name: string; input: Record<string, unknown> };
  decision?: Record<string, unknown>;
}

export interface MockProvider {
  client: { messages: { create(req: unknown): Promise<Record<string, unknown>> } };
  /** Request ids the provider served, in order (its side of the ledger). */
  log: string[];
  /** Failure injection: the next create() times out client-side (never reaches the provider). */
  failNext?: "timeout";
}

export function createMockProvider(opts: {
  /** Scripted response for a request (by conversation position); undefined = a short generic reply. */
  respond: (req: unknown) => MockResponse | undefined;
  wait: Wait;
  onGenerate?: (chunk: string) => void;
  timeoutMs?: number;
}): MockProvider {
  const provider: MockProvider = {
    log: [],
    client: {
      messages: {
        async create(req: unknown) {
          if (provider.failNext === "timeout") {
            provider.failNext = undefined;
            await opts.wait(opts.timeoutMs ?? 1200);
            throw Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError", kind: "llm_timeout" });
          }
          const next = opts.respond(req) ?? { thinking: "Nothing scripted for this turn.", say: "Okay.", decision: undefined };
          const request_id = `req_${randomBytes(12).toString("hex")}`;
          provider.log.push(request_id);
          await opts.wait(400); // time to first token
          for (const chunk of next.thinking.match(/\S+\s*/g) ?? []) {
            opts.onGenerate?.(chunk);
            await opts.wait(35);
          }
          await opts.wait(150);
          const content: Record<string, unknown>[] = [
            { type: "thinking", thinking: next.thinking, signature: randomBytes(16).toString("hex") },
            { type: "text", text: next.say },
          ];
          if (next.tool) content.push({ type: "tool_use", id: `toolu_${randomBytes(8).toString("hex")}`, ...next.tool });
          if (next.decision) content.push({ type: "tool_use", id: `toolu_${randomBytes(8).toString("hex")}`, name: "record_decision", input: next.decision });
          return {
            id: `msg_${randomBytes(12).toString("hex")}`,
            _request_id: request_id,
            type: "message",
            role: "assistant",
            model: "mock-llm",
            stop_reason: "tool_use",
            content,
            usage: { input_tokens: 1800, output_tokens: next.thinking.split(/\s+/).length + 60 },
          };
        },
      },
    },
  };
  return provider;
}

export interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

type Route = (method: string, path: string, body?: unknown) => HttpResult | undefined;

/** A mock HTTP service client with get/post methods (duck-typed like most SDKs). */
export class MockService {
  constructor(
    private readonly route: Route,
    private readonly wait: Wait,
    private readonly latencyMs = 150,
  ) {}

  async get(path: string): Promise<HttpResult> {
    return this.call("GET", path);
  }

  async post(path: string, body: unknown, _opts?: { idempotencyKey?: string }): Promise<HttpResult> {
    return this.call("POST", path, body);
  }

  private async call(method: string, path: string, body?: unknown): Promise<HttpResult> {
    await this.wait(this.latencyMs);
    return this.route(method, path, body) ?? { status: 404, body: { error: "not found" } };
  }
}
