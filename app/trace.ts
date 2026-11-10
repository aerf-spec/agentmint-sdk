// Least-interference, framework-agnostic call-stack tracing for agents.
//
// Public surface (all duck-typed; no framework or provider SDK imports):
//   traceLLM(client, { method, map })   llm.request + llm.response spans
//   traceTools({ ...tools })            tool.dispatch + tool.exec + tool.result spans
//   traceDownstream(name, client)       downstream.call spans (service + route)
//   decision(record, spec)              validate, apply field policy, leak-scan,
//                                       and issue the signed receipt for the step
//   @traced(kind, name?)                TC39 method decorator on the same core
//   traceCall / traceTurn               scope a call and one agent step (harness only)
//
// Wrap once at construction; agent logic calls nothing but decision(). Outside
// a traced call every wrapper is a transparent pass-through.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { canonicalizeLoose, sha256Hex } from "../src/kernel/canonical.js";

// ── Types ───────────────────────────────────────────────────────────

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface Span {
  trace_id: string;
  span_id: string;
  parent_id: string | null;
  step: number | null;
  kind: string;
  name: string;
  start_us: number;
  dur_us: number;
  t_us: number;
  wall: string;
  attrs: Record<string, Json>;
  /** sha256(nonce + ":" + canonical(attrs)): a salted commitment, so low-entropy attrs cannot be guessed from the receipt. */
  attrs_sha256: string;
  /** Per-span random salt for attrs_sha256 (streamed to the vendor view, never signed). */
  nonce: string;
  /** Name as committed in receipts: identifiers in routes replaced by ":id". */
  public_name: string;
  status: "ok" | "error" | "open";
  attempt: number;
  error_kind?: string;
}

/** What a signed receipt commits to: the step's spans, attrs as hashes. */
export interface StackEntry {
  span_id: string;
  parent_id: string | null;
  kind: string;
  name: string;
  dur_us: number;
  attrs_sha256: string;
  status: "ok" | "error" | "open";
  attempt: number;
  error_kind?: string;
}

export interface LlmMapped {
  request_id?: string;
  model?: string;
  thinking?: string;
  tool_calls?: Array<{ name: string; input: unknown }>;
  stop_reason?: string;
}
export type LlmMap = (req: unknown, res: unknown) => LlmMapped;

/** An atomic claim cut from raw thinking, citing what it rests on. Text is private. */
export interface Claim {
  id: string;
  text: string;
  cites: Array<{ kind: "rule" | "tool" | "turn" | "claim"; ref: string }>;
}

export interface Failure {
  step: number | null;
  span_id: string;
  kind: string;
  attempt: number;
  span_kind: string;
}

/** Everything the runtime needs to issue one receipt for a step. */
export interface ReceiptRequest {
  kind: "decision" | "error";
  step: number | null;
  trace_id: string;
  root: Span;
  stack: StackEntry[];
  salt: string;
  record?: Record<string, Json>;
  error?: { kind: string; attempt: number; span_id: string; span_kind: string };
  claims: Claim[];
  request_ids: string[];
  thinking: string;
  context: unknown[];
  started_ns: bigint;
}

export interface CallHooks {
  /** Issue a signed receipt (decision or error). The only path to the signer. */
  sign(req: ReceiptRequest): Promise<unknown>;
  onSpan?(span: Span): void;
  onLlmRequest?(req: unknown, step: number | null): void;
  onToolCall?(name: string, input: unknown, step: number | null): void;
  onToolResult?(name: string, result: unknown, step: number | null): void;
  onDecision?(record: Record<string, Json>, step: number | null, claims: Claim[]): void;
  /** Vendor-side claim extractor: cut the step's raw thinking into cited claims. */
  claims?(thinking: string, step: number | null): Claim[];
  onFailure?(f: Failure): void;
}

export interface CallCounts {
  llm_calls: number;
  tool_calls: number;
  downstream_calls: number;
  decisions: number;
  errors: number;
}

export class CallTrace {
  readonly trace_id = randomBytes(16).toString("hex");
  readonly counts: CallCounts = { llm_calls: 0, tool_calls: 0, downstream_calls: 0, decisions: 0, errors: 0 };
  /** Provider request ids observed by traceLLM, in order. */
  readonly requestIds: string[] = [];
  readonly corpus = new Shingles();
  constructor(readonly hooks: CallHooks, readonly t0: bigint = process.hrtime.bigint()) {}
  us(ns: bigint = process.hrtime.bigint()): number {
    return Number((ns - this.t0) / 1000n);
  }
}

interface StepState {
  step: number;
  root: Span;
  rootStartNs: bigint;
  spans: Span[];
  open: Map<string, { span: Span; startNs: bigint }>;
  attempts: Map<string, number>;
  requestIds: string[];
  thinking: string[];
  llmRequests: unknown[];
  failures: Failure[];
  decided: boolean;
}

interface Ctx {
  call: CallTrace;
  step?: StepState;
  span?: Span;
}

const als = new AsyncLocalStorage<Ctx>();
const recorded = new WeakSet<object>();

// ── Core ────────────────────────────────────────────────────────────

const spanId = () => randomBytes(8).toString("hex");
const digest = (v: unknown) => sha256Hex(Buffer.from(canonicalizeLoose(v ?? null), "utf8"));

function openSpan(ctx: Ctx, kind: string, name: string, attrs: Record<string, Json>, publicName = name): { span: Span; startNs: bigint } {
  const startNs = process.hrtime.bigint();
  const step = ctx.step;
  const key = `${kind}:${name}`;
  const attempt = step ? (step.attempts.get(key) ?? 0) + 1 : 1;
  step?.attempts.set(key, attempt);
  const span: Span = {
    trace_id: ctx.call.trace_id,
    span_id: spanId(),
    parent_id: ctx.span?.span_id ?? null,
    step: step?.step ?? null,
    kind,
    name,
    start_us: ctx.call.us(startNs),
    dur_us: 0,
    t_us: 0,
    wall: "",
    attrs,
    attrs_sha256: "",
    nonce: randomBytes(16).toString("hex"),
    public_name: publicName,
    status: "open",
    attempt,
  };
  step?.open.set(span.span_id, { span, startNs });
  return { span, startNs };
}

function closeSpan(ctx: Ctx, span: Span, startNs: bigint, err?: unknown): void {
  const end = process.hrtime.bigint();
  span.dur_us = Number((end - startNs) / 1000n);
  span.t_us = ctx.call.us(end);
  span.wall = new Date().toISOString();
  span.status = err === undefined ? "ok" : "error";
  if (err !== undefined) {
    span.error_kind = errorKind(err, span.kind);
    span.attrs.error_kind = span.error_kind;
  }
  span.attrs_sha256 = attrsCommitment(span);
  ctx.step?.open.delete(span.span_id);
  ctx.step?.spans.push(span);
  ctx.call.hooks.onSpan?.(span);
}

/** Salted commitment to a span's attrs (verifiable from the streamed span: nonce + attrs). */
export function attrsCommitment(span: Pick<Span, "nonce" | "attrs">): string {
  return sha256Hex(Buffer.from(`${span.nonce}:${canonicalizeLoose(span.attrs)}`, "utf8"));
}

/** "/members/NH-552019/benefits?type=pt" -> "/members/:id/benefits?…": no identifiers in signed names. */
export function routeTemplate(route: string): string {
  const [path, query] = route.split("?", 2);
  const segs = (path ?? "").split("/").map((seg) => (/\d/.test(seg) || seg.length > 24 ? ":id" : seg));
  return segs.join("/") + (query !== undefined ? "?…" : "");
}

function errorKind(err: unknown, spanKind: string): string {
  const e = err as { kind?: unknown; name?: unknown; message?: unknown };
  if (typeof e?.kind === "string") return e.kind;
  const text = `${String(e?.name ?? "")} ${String(e?.message ?? "")}`;
  if (/timeout|timed out/i.test(text)) return spanKind.startsWith("llm") ? "llm_timeout" : "timeout";
  if (spanKind.startsWith("tool")) return "tool_error";
  if (spanKind === "downstream.call") return "downstream_error";
  return "error";
}

/** Run fn as a child span of the current span. Pass-through outside a traced call. */
async function withSpan<T>(
  kind: string,
  name: string,
  attrs: Record<string, Json>,
  fn: (span: Span | undefined) => Promise<T> | T,
  publicName?: string,
): Promise<T> {
  const ctx = als.getStore();
  if (!ctx) return fn(undefined);
  const { span, startNs } = openSpan(ctx, kind, name, attrs, publicName);
  let result: T;
  try {
    result = await als.run({ ...ctx, span }, () => fn(span));
  } catch (err) {
    closeSpan(ctx, span, startNs, err);
    if (typeof err === "object" && err !== null && !recorded.has(err)) {
      recorded.add(err);
      await recordFailure(ctx, span);
    }
    throw err;
  }
  closeSpan(ctx, span, startNs);
  return result;
}

async function recordFailure(ctx: Ctx, span: Span): Promise<void> {
  const f: Failure = {
    step: ctx.step?.step ?? null,
    span_id: span.span_id,
    kind: span.error_kind ?? "error",
    attempt: span.attempt,
    span_kind: span.kind,
  };
  ctx.call.counts.errors += 1;
  ctx.step?.failures.push(f);
  ctx.call.hooks.onFailure?.(f);
  if (ctx.step) {
    // Failures are part of the chain: an error receipt commits to the stack so far.
    await ctx.call.hooks.sign(receiptRequest(ctx, ctx.step, "error", randomBytes(32).toString("hex"), process.hrtime.bigint(), {
      error: { kind: f.kind, attempt: f.attempt, span_id: f.span_id, span_kind: f.span_kind },
    }));
  }
}

function snapshotStack(step: StepState): StackEntry[] {
  const now = process.hrtime.bigint();
  const all: Span[] = [...step.spans];
  for (const { span, startNs } of step.open.values()) {
    all.push({ ...span, dur_us: Number((now - startNs) / 1000n), attrs_sha256: attrsCommitment(span) });
  }
  all.sort((a, b) => a.start_us - b.start_us);
  return all.map((s) => ({
    span_id: s.span_id,
    parent_id: s.parent_id,
    kind: s.kind,
    name: s.public_name,
    dur_us: s.dur_us,
    attrs_sha256: s.attrs_sha256,
    status: s.status,
    attempt: s.attempt,
    ...(s.error_kind ? { error_kind: s.error_kind } : {}),
  }));
}

function receiptRequest(
  ctx: Ctx,
  step: StepState,
  kind: "decision" | "error",
  salt: string,
  startedNs: bigint,
  extra: Pick<ReceiptRequest, "record" | "error"> & { claims?: Claim[] },
): ReceiptRequest {
  return {
    kind,
    step: step.step,
    trace_id: ctx.call.trace_id,
    root: step.root,
    stack: snapshotStack(step),
    salt,
    request_ids: [...step.requestIds],
    thinking: step.thinking.join("\n"),
    context: [...step.llmRequests],
    started_ns: startedNs,
    claims: [],
    ...extra,
  };
}

// ── Scopes (harness) ────────────────────────────────────────────────

/** Run one call (conversation) under a fresh trace. */
export function traceCall<T>(hooks: CallHooks, fn: (call: CallTrace) => Promise<T>, t0?: bigint): Promise<T> {
  const call = new CallTrace(hooks, t0);
  return als.run({ call }, () => fn(call));
}

/** Run one agent step under a `turn` root span. */
export async function traceTurn<T>(meta: { step: number; at?: string }, fn: () => Promise<T>): Promise<T> {
  const ctx = als.getStore();
  if (!ctx) return fn();
  const startNs = process.hrtime.bigint();
  const step: StepState = {
    step: meta.step,
    root: undefined as unknown as Span,
    rootStartNs: startNs,
    spans: [],
    open: new Map(),
    attempts: new Map(),
    requestIds: [],
    thinking: [],
    llmRequests: [],
    failures: [],
    decided: false,
  };
  const stepCtx: Ctx = { call: ctx.call, step };
  const { span: root } = openSpan(stepCtx, "turn", `turn ${meta.step}`, { step: meta.step, ...(meta.at ? { at: meta.at } : {}) });
  step.root = root;
  try {
    const out = await als.run({ ...stepCtx, span: root }, fn);
    if (!step.decided) closeSpan(stepCtx, root, startNs);
    return out;
  } catch (err) {
    if (step.open.has(root.span_id)) closeSpan(stepCtx, root, startNs, err);
    if (typeof err === "object" && err !== null && !recorded.has(err)) {
      recorded.add(err);
      await recordFailure(stepCtx, root);
    }
    throw err;
  }
}

/** Failures captured in the current call's step so far (for the harness). */
export function stepFailures(): Failure[] {
  return [...(als.getStore()?.step?.failures ?? [])];
}

// ── traceLLM ────────────────────────────────────────────────────────

/** Wrap a model client's call (e.g. "messages.create", "chat.completions.create"). */
export function traceLLM<T extends object>(client: T, opts: { method?: string; map?: LlmMap } = {}): T {
  const method = opts.method ?? "messages.create";
  const map = opts.map ?? genericMap;
  return wrapPath(client, method.split("."), (orig, self) => async (...args: unknown[]) => {
    const req = args[0];
    return withSpan("llm.request", method, { method, request_sha256: digest(req) }, async (span) => {
      const ctx = als.getStore();
      if (ctx && span) {
        ctx.call.counts.llm_calls += 1;
        ctx.step?.llmRequests.push(req);
        ctx.call.corpus.add(systemText(req));
        ctx.call.hooks.onLlmRequest?.(req, ctx.step?.step ?? null);
      }
      const res = await (orig as (...a: unknown[]) => Promise<unknown>).apply(self, args);
      if (ctx && span) {
        const m = map(req, res);
        if (m.request_id) {
          ctx.call.requestIds.push(m.request_id);
          ctx.step?.requestIds.push(m.request_id);
          span.attrs.request_id = m.request_id;
        }
        if (m.thinking) {
          ctx.step?.thinking.push(m.thinking);
          ctx.call.corpus.add(m.thinking);
        }
        const attrs: Record<string, Json> = {
          model: m.model ?? "unknown",
          thinking_sha256: m.thinking ? sha256Hex(Buffer.from(m.thinking, "utf8")) : null,
          thinking_words: m.thinking ? m.thinking.split(/\s+/).filter(Boolean).length : 0,
          tool_calls: (m.tool_calls ?? []).map((t) => t.name),
          stop_reason: m.stop_reason ?? null,
          ...(m.request_id ? { request_id: m.request_id } : {}),
        };
        await withSpan("llm.response", m.model ?? "response", attrs, () => undefined);
      }
      return res;
    });
  });
}

function systemText(req: unknown): string {
  const r = req as { system?: unknown; instructions?: unknown; messages?: unknown; input?: unknown };
  const parts: string[] = [];
  const take = (v: unknown) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) for (const b of v) take((b as { text?: unknown })?.text ?? b);
  };
  take(r?.system);
  take(r?.instructions);
  for (const list of [r?.messages, r?.input]) {
    if (!Array.isArray(list)) continue;
    for (const m of list as Array<{ role?: unknown; content?: unknown }>) {
      if (m?.role === "system" || m?.role === "developer") take(m.content);
    }
  }
  return parts.join("\n");
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const parseArgs = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/** Anthropic-shaped response: content blocks of thinking / text / tool_use. */
export const anthropicMap: LlmMap = (_req, res) => {
  const r = obj(res);
  const blocks = Array.isArray(r.content) ? (r.content as unknown[]).map(obj) : [];
  return {
    request_id: str(r._request_id) ?? str(r.id),
    model: str(r.model),
    thinking: blocks.filter((b) => b.type === "thinking").map((b) => str(b.thinking) ?? "").join("\n") || undefined,
    tool_calls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ name: String(b.name), input: b.input })),
    stop_reason: str(r.stop_reason),
  };
};

/** OpenAI-shaped response: chat.completions choices, or Responses API output items. */
export const openaiMap: LlmMap = (_req, res) => {
  const r = obj(res);
  const base = { request_id: str(r._request_id) ?? str(r.id), model: str(r.model) };
  if (Array.isArray(r.choices)) {
    const choice = obj((r.choices as unknown[])[0]);
    const msg = obj(choice.message);
    const calls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as unknown[]).map(obj) : [];
    return {
      ...base,
      thinking: str(msg.reasoning_content) ?? str(msg.reasoning),
      tool_calls: calls.map((c) => ({ name: String(obj(c.function).name), input: parseArgs(obj(c.function).arguments) })),
      stop_reason: str(choice.finish_reason),
    };
  }
  const items = Array.isArray(r.output) ? (r.output as unknown[]).map(obj) : [];
  const reasoning = items
    .filter((i) => i.type === "reasoning")
    .flatMap((i) => (Array.isArray(i.summary) ? (i.summary as unknown[]).map((s) => str(obj(s).text) ?? "") : []));
  return {
    ...base,
    thinking: reasoning.join("\n") || undefined,
    tool_calls: items.filter((i) => i.type === "function_call").map((i) => ({ name: String(i.name), input: parseArgs(i.arguments) })),
    stop_reason: str(r.status),
  };
};

/** Default: recognise either shape, else read flat fields. */
export const genericMap: LlmMap = (req, res) => {
  const r = obj(res);
  if (Array.isArray(r.content)) return anthropicMap(req, res);
  if (Array.isArray(r.choices) || Array.isArray(r.output)) return openaiMap(req, res);
  const calls = Array.isArray(r.tool_calls) ? (r.tool_calls as unknown[]).map(obj) : [];
  return {
    request_id: str(r.request_id) ?? str(r.id),
    model: str(r.model),
    thinking: str(r.thinking) ?? str(r.reasoning),
    tool_calls: calls.map((c) => ({ name: String(c.name), input: parseArgs(c.input ?? c.arguments) })),
    stop_reason: str(r.stop_reason),
  };
};

// ── traceTools ──────────────────────────────────────────────────────

export type ToolMap = Record<string, (input: never) => Promise<unknown>>;

/** Wrap every tool in a map. Each call: tool.dispatch → tool.exec → tool.result. */
export function traceTools<T extends ToolMap>(tools: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(tools)) {
    out[name] = (input: unknown) =>
      withSpan("tool.dispatch", name, { tool: name }, async (span) => {
        const ctx = als.getStore();
        if (ctx && span) {
          ctx.call.counts.tool_calls += 1;
          ctx.call.hooks.onToolCall?.(name, input, ctx.step?.step ?? null);
        }
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
          throw Object.assign(new Error(`tool ${name}: input must be an object`), { kind: "malformed_tool_input" });
        }
        const result = await withSpan("tool.exec", name, { tool: name, input_sha256: digest(input) }, () =>
          (fn as (i: unknown) => Promise<unknown>)(input),
        );
        await withSpan("tool.result", name, { tool: name, result_sha256: digest(result) }, () => {
          if (ctx && span) ctx.call.hooks.onToolResult?.(name, result, ctx.step?.step ?? null);
        });
        return result;
      });
  }
  return out as T;
}

// ── traceDownstream ─────────────────────────────────────────────────

const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head"]);

function routeOf(method: string, args: unknown[]): { verb: string; route: string } {
  const a0 = args[0];
  const verb = HTTP_VERBS.has(method.toLowerCase()) ? method.toUpperCase() : method;
  if (typeof a0 === "string") return { verb, route: a0 };
  const o = obj(a0);
  const path = str(o.path) ?? str(o.url) ?? str(o.route);
  if (path) return { verb: str(o.method)?.toUpperCase() ?? verb, route: path };
  return { verb, route: "" };
}

/** Wrap every async method of a client object (or only `opts.methods`). */
export function traceDownstream<T extends object>(service: string, client: T, opts: { methods?: string[] } = {}): T {
  const cache = new Map<PropertyKey, unknown>();
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string" || prop === "constructor" || prop === "then") return value;
      if (opts.methods && !opts.methods.includes(prop)) return value;
      if (!cache.has(prop)) {
        cache.set(prop, (...args: unknown[]) => {
          const { verb, route } = routeOf(prop, args);
          const name = `${service} ${verb}${route ? " " + route : ""}`;
          const publicName = `${service} ${verb}${route ? " " + routeTemplate(route) : ""}`;
          return withSpan("downstream.call", name, { service, method: verb, route }, async (span) => {
            const ctx = als.getStore();
            if (ctx && span) ctx.call.counts.downstream_calls += 1;
            const res = await (value as (...a: unknown[]) => unknown).apply(target, args);
            const status = obj(res).status;
            if (span && typeof status === "number" && Number.isInteger(status)) span.attrs.status = status;
            return res;
          }, publicName);
        });
      }
      return cache.get(prop);
    },
  });
}

/** Proxy that replaces the function at `path` (e.g. ["messages", "create"]). */
function wrapPath<T extends object>(
  target: T,
  path: string[],
  wrap: (orig: unknown, self: unknown) => (...args: unknown[]) => unknown,
): T {
  const [head, ...rest] = path;
  let cached: unknown;
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (prop !== head) return value;
      if (cached) return cached;
      if (rest.length === 0) {
        if (typeof value !== "function") return value;
        cached = wrap(value, t);
      } else {
        if (typeof value !== "object" || value === null) return value;
        cached = wrapPath(value as object, rest, wrap);
      }
      return cached;
    },
  });
}

// ── @traced (TC39 standard method decorator) ────────────────────────

/** `@traced("agent.plan")` on a class method: one span around each call. */
export function traced(kind: string, name?: string) {
  return function <This, A extends unknown[], R>(
    target: (this: This, ...args: A) => R,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: A) => R>,
  ) {
    const spanName = name ?? String(context.name);
    return function (this: This, ...args: A): R {
      return withSpan(kind, spanName, {}, () => target.apply(this, args)) as R;
    };
  };
}

// ── decision() ──────────────────────────────────────────────────────

/** Field rule: an enum list, or a primitive kind. "text" is free text (leak-scanned). */
export type FieldRule = readonly string[] | "int" | "bool" | "id" | "text" | { list: Record<string, FieldRule> };
export type FieldPolicy = "visible" | "hashed" | "dropped";

export interface DecisionSpec {
  schema: string;
  fields: Record<string, FieldRule>;
  /** Per-field policy; default visible. Hashed = sha256(salt:canonical(value)). */
  policy?: Record<string, FieldPolicy>;
}

export class DecisionError extends Error {
  constructor(readonly kind: "invalid_decision" | "leak_blocked", message: string) {
    super(message);
  }
}

const ID_RE = /^[A-Za-z0-9_.:\-/]{1,64}$/;

function validateField(rule: FieldRule, v: unknown, path: string): void {
  const bad = (why: string) => {
    throw new DecisionError("invalid_decision", `${path}: ${why}`);
  };
  if (Array.isArray(rule)) {
    if (typeof v !== "string" || !rule.includes(v)) bad(`must be one of ${rule.join("|")}`);
  } else if (rule === "int") {
    if (typeof v !== "number" || !Number.isSafeInteger(v)) bad("must be an integer");
  } else if (rule === "bool") {
    if (typeof v !== "boolean") bad("must be a boolean");
  } else if (rule === "id") {
    if (typeof v !== "string" || !ID_RE.test(v)) bad("must be a short identifier");
  } else if (rule === "text") {
    if (typeof v !== "string" || v.length > 500) bad("must be a string of at most 500 characters");
  } else if (typeof rule === "object" && "list" in rule) {
    if (!Array.isArray(v) || v.length > 32) bad("must be a list of at most 32 items");
    (v as unknown[]).forEach((item, i) => validateRecord(rule.list, item, `${path}[${i}]`));
  }
}

function validateRecord(fields: Record<string, FieldRule>, rec: unknown, path: string): void {
  if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
    throw new DecisionError("invalid_decision", `${path}: must be an object`);
  }
  for (const k of Object.keys(rec)) {
    if (!(k in fields)) throw new DecisionError("invalid_decision", `${path}.${k}: unknown field`);
  }
  for (const [k, rule] of Object.entries(fields)) {
    validateField(rule, (rec as Record<string, unknown>)[k], `${path}.${k}`);
  }
}

/** Apply visible | hashed | dropped per top-level field. */
export function applyFieldPolicy(
  rec: Record<string, Json>,
  policy: Record<string, FieldPolicy> = {},
  salt: string,
): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(rec)) {
    const p = policy[k] ?? "visible";
    if (p === "dropped") continue;
    out[k] = p === "hashed" ? { sha256: sha256Hex(Buffer.from(`${salt}:${canonicalizeLoose(v)}`, "utf8")) } : v;
  }
  return out;
}

/** Word 6-gram shingles of private text (prompt, raw thinking). */
export class Shingles {
  private readonly set = new Set<string>();
  static N = 6;
  private static words(s: string): string[] {
    return s.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}$%]+/gu) ?? [];
  }
  add(text: string): void {
    const w = Shingles.words(text);
    for (let i = 0; i + Shingles.N <= w.length; i++) this.set.add(w.slice(i, i + Shingles.N).join(" "));
  }
  /** First shared 6-gram between `text` and the private corpus, if any. */
  overlap(text: string): string | undefined {
    const w = Shingles.words(text);
    for (let i = 0; i + Shingles.N <= w.length; i++) {
      const g = w.slice(i, i + Shingles.N).join(" ");
      if (this.set.has(g)) return g;
    }
    return undefined;
  }
}

function visibleStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => visibleStrings(x, out));
  else if (typeof v === "object" && v !== null) Object.values(v).forEach((x) => visibleStrings(x, out));
  return out;
}

/**
 * Validate a decision record, apply the field policy, leak-scan every visible
 * string against the private prompt and raw thinking (fail closed), and issue
 * the step's signed receipt, committing to the step's whole span stack.
 */
export async function decision(record: unknown, spec: DecisionSpec): Promise<unknown> {
  const startedNs = process.hrtime.bigint();
  const ctx = als.getStore();
  const step = ctx?.step;
  if (!ctx || !step) throw new Error("decision() must run inside traceTurn()");
  const salt = randomBytes(32).toString("hex");
  let applied: Record<string, Json> = {};
  let claims: Claim[] = [];
  await withSpan("decision", spec.schema, { schema: spec.schema }, (span) => {
    validateRecord(spec.fields, record, "decision");
    applied = applyFieldPolicy(record as Record<string, Json>, spec.policy, salt);
    claims = ctx.call.hooks.claims?.(step.thinking.join("\n"), step.step) ?? [];
    validateClaims(claims);
    const names = step.spans.map((s) => s.name);
    const cites = claims.flatMap((c) => [c.id, ...c.cites.map((x) => x.ref)]);
    for (const s of [...visibleStrings(applied), ...names, ...cites]) {
      if (ctx.call.corpus.overlap(s)) {
        throw new DecisionError("leak_blocked", "a visible field overlaps private prompt or thinking text");
      }
    }
    if (span) {
      for (const [k, v] of Object.entries(applied)) if (typeof v !== "object") span.attrs[k] = v;
    }
  });
  ctx.call.counts.decisions += 1;
  const full = { schema: spec.schema, ...applied };
  ctx.call.hooks.onDecision?.(full, step.step, claims);
  // The decision closes the turn: the receipt commits to a finished stack.
  step.decided = true;
  if (step.open.has(step.root.span_id)) closeSpan({ call: ctx.call, step }, step.root, step.rootStartNs);
  return ctx.call.hooks.sign(receiptRequest(ctx, step, "decision", salt, startedNs, { record: full, claims }));
}

const CITE_KINDS = new Set(["rule", "tool", "turn", "claim"]);
const REF_RE = /^[A-Za-z0-9_.:\-\[\]/]{1,96}$/;

function validateClaims(claims: Claim[]): void {
  const ids = new Set<string>();
  for (const c of claims) {
    if (!ID_RE.test(c.id) || ids.has(c.id)) throw new DecisionError("invalid_decision", `claim id ${c.id} invalid or duplicate`);
    for (const x of c.cites) {
      if (!CITE_KINDS.has(x.kind) || !REF_RE.test(x.ref)) throw new DecisionError("invalid_decision", `claim ${c.id}: bad cite`);
      if (x.kind === "claim" && !ids.has(x.ref)) throw new DecisionError("invalid_decision", `claim ${c.id} cites unknown or later claim ${x.ref}`);
    }
    ids.add(c.id);
  }
}
