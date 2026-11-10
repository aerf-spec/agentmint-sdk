// filet-call: live backend for the filet.ai demo.
//
//   POST /call[?fail=llm_timeout|tool_error|authority_down|signer_crash]  -> 201 { id }
//   GET  /call/:id/events         SSE (Last-Event-ID resumable)
//   POST /call/:id/turn { text }  -> 202, runs Ava's agent loop
//   POST /call/:id/end            -> reconcile, close receipt, done
//   GET  /disclose/:receipt_id    -> { salt, text }  (Authorization: Bearer DISCLOSE_TOKEN)
//
// One Durable Object per call holds the transcript, the chain state and the
// event log. Signing happens in filet-signer (service binding); this Worker
// never holds the issuer key. Anchoring is off the hot path (250 ms / 64 leaves).

import { DurableObject } from "cloudflare:workers";
import {
  canonicalBytes,
  edVerify,
  importPublicPem,
  isoNowUtc,
  logLeafHash,
  sha256Hex,
  signedPayloadBytes,
  toHex,
  verifyConsistency,
  walkAuditPath,
} from "../../shared/canonical";
import {
  HttpError,
  RateLimiter,
  assertPostOrigin,
  corsHeaders,
  preflight,
  rateLimit,
  readCappedJson,
  requireBearer,
  strictObject,
} from "../../shared/http";
import { AnthropicError, streamMessage, type Block, type StreamResult } from "./anthropic";
import { LeakScanner, type StreamGuard } from "./leak";
import { INFRA_PRICES, PRICES, priceFor, usdFor } from "./costs";
import {
  AGENT,
  CITE_KINDS,
  DECISIONS,
  EFFORT,
  GREETING,
  MODEL,
  POINTS,
  PRIVATE_INPUT_FIELDS,
  PRIVATE_PROMPT,
  PROMPT_VERSION,
  RULES,
  TOOLS,
  UNCERTAINTY,
  runMockTool,
  type CallFacts,
} from "./scenario";

export { RateLimiter };

export interface SignOut {
  receipt: Record<string, unknown> & { key_id: string; signature: string };
  receipt_hash: string;
  leaf_hash: string;
  sign_us: number;
  hot_us: number;
}
/** RPC surface of filet-signer (see ../signer/src/index.ts). */
export interface SignerRpc {
  info(): Promise<{ public_key_pem: string; key_id: string }>;
  signReceipt(fields: Record<string, unknown>): Promise<SignOut>;
  signBatch(leafHashes: string[], batchTs: string): Promise<{ batch_signature: string; key_id: string }>;
}
interface CallRpc {
  init(id: string, fail: string | null): Promise<void>;
  turn(text: string): Promise<{ status: number; body: unknown }>;
  end(): Promise<{ status: number; body: unknown }>;
  stop(): Promise<{ status: number; body: unknown }>;
  package(authorityOrigin: string): Promise<unknown>;
  disclose(receiptId: string): Promise<{ receipt_id: string; salt: string; text: string; commitment_alg: string } | null>;
  fetch(req: Request): Promise<Response>;
}
const callStub = (env: Env, id: string) => env.CALL.get(env.CALL.idFromName(id)) as unknown as CallRpc;

export interface Env {
  CALL: DurableObjectNamespace<CallDO>;
  CALL_INDEX: DurableObjectNamespace<CallIndex>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  SIGNER: SignerRpc;
  AUTHORITY: Fetcher;
  ANTHROPIC_API_KEY?: string;
  REGISTRATION_TOKEN?: string;
  DISCLOSE_TOKEN?: string;
  TRACE_URL_TEMPLATE?: string;
  AUTHORITY_ORIGIN?: string;
}

const FAIL_MODES = ["llm_timeout", "tool_error", "authority_down", "signer_crash"] as const;
type FailMode = (typeof FAIL_MODES)[number];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TURN_BYTES = 2048;
const LIMITS = { calls: 5, turns: 30, sse: 60, disclose: 30, end: 10, costs: 60 };
const GLOBAL_TURNS_PER_DAY = 1500;
const MAX_TURNS_PER_CALL = 25;
const MAX_ITERATIONS = 8;
const MAX_SSE_CLIENTS = 8;
const METHODS = "GET, POST";
const ALLOW_HEADERS = "content-type, authorization, last-event-id";

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

// ── Worker router ───────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return preflight(req, METHODS, ALLOW_HEADERS);
    const cors = corsHeaders(req, METHODS, ALLOW_HEADERS);
    let res: Response;
    try {
      res = await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.message }, e.status, e.headers);
      else {
        console.error(e);
        res = json({ error: "internal error" }, 500);
      }
    }
    const r = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
    return r;
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p === "/healthz") return new Response("ok");
  if (req.method === "POST") assertPostOrigin(req);

  if (req.method === "POST" && p === "/call") {
    await rateLimit(env, req, "calls", LIMITS.calls);
    for (const k of url.searchParams.keys()) if (k !== "fail") throw new HttpError(400, `unknown query parameter: ${k.slice(0, 40)}`);
    const fail = url.searchParams.get("fail");
    if (fail !== null && !FAIL_MODES.includes(fail as FailMode)) throw new HttpError(400, `fail must be one of ${FAIL_MODES.join(", ")}`);
    if (req.headers.get("content-length") && req.headers.get("content-length") !== "0") {
      strictObject(await readCappedJson(req, 256), []);
    }
    const id = crypto.randomUUID();
    const stub = callStub(env, id);
    await stub.init(id, (fail as FailMode | null) ?? null);
    return json({ id, events: `/call/${id}/events`, turn: `/call/${id}/turn` }, 201);
  }

  if (req.method === "GET" && p === "/issuer") {
    await rateLimit(env, req, "costs", LIMITS.costs);
    const info = await env.SIGNER.info();
    return json({ ...info, held_by: "filet-signer" });
  }

  if (req.method === "GET" && p === "/calls/costs") {
    await rateLimit(env, req, "costs", LIMITS.costs);
    const idx = env.CALL_INDEX.get(env.CALL_INDEX.idFromName("index")) as unknown as CallIndexRpc;
    const calls = (await idx.list(100)).map((c) => ({ ...c, usd: c.usd_total }));
    const total_usd = Math.round(calls.reduce((a, c) => a + c.usd_total, 0) * 1e6) / 1e6;
    return json({ prices_as_of: PRICES.prices_as_of, calls, total_usd });
  }

  let m = /^\/call\/([^/]+)\/(events|turn|end|stop|interrupt|package)$/.exec(p);
  if (m) {
    const id = m[1]!;
    if (!UUID_RE.test(id)) throw new HttpError(404, "unknown call");
    const stub = callStub(env, id);
    if (m[2] === "events" && req.method === "GET") {
      await rateLimit(env, req, "sse", LIMITS.sse);
      return stub.fetch(req);
    }
    if (m[2] === "turn" && req.method === "POST") {
      await rateLimit(env, req, "turns", LIMITS.turns);
      const body = strictObject(await readCappedJson(req, MAX_TURN_BYTES + 64), ["text"]);
      const text = body.text;
      if (typeof text !== "string") throw new HttpError(400, "text must be a string");
      const t = text.trim();
      if (!t) throw new HttpError(400, "text must not be empty");
      if (new TextEncoder().encode(t).length > MAX_TURN_BYTES) throw new HttpError(413, `text exceeds ${MAX_TURN_BYTES} bytes`);
      if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(t)) throw new HttpError(400, "text contains control characters");
      // Global spend guard across all callers.
      const g = await env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("__global__")).check("turns-day", GLOBAL_TURNS_PER_DAY, 86_400_000);
      if (!g.ok) throw new HttpError(429, "daily demo budget exhausted", { "retry-after": String(g.retryAfter) });
      const r = await stub.turn(t);
      return json(r.body, r.status);
    }
    if (m[2] === "package" && req.method === "GET") {
      await rateLimit(env, req, "costs", LIMITS.costs);
      const pkg = await stub.package(env.AUTHORITY_ORIGIN ?? "https://filet-authority.anikethsubs.workers.dev");
      if (!pkg) throw new HttpError(404, "unknown call");
      return json(pkg);
    }
    if ((m[2] === "stop" || m[2] === "interrupt") && req.method === "POST") {
      await rateLimit(env, req, "turns", LIMITS.turns);
      const r = await stub.stop();
      return json(r.body, r.status);
    }
    if (m[2] === "end" && req.method === "POST") {
      await rateLimit(env, req, "end", LIMITS.end);
      const r = await stub.end();
      return json(r.body, r.status);
    }
    throw new HttpError(405, "method not allowed");
  }

  m = /^\/disclose\/([^/]+)$/.exec(p);
  if (m && req.method === "GET") {
    await rateLimit(env, req, "disclose", LIMITS.disclose);
    requireBearer(req, env.DISCLOSE_TOKEN);
    const rm = /^([0-9a-f-]{36})-r(\d{1,6})$/.exec(decodeURIComponent(m[1]!));
    if (!rm || !UUID_RE.test(rm[1]!)) throw new HttpError(404, "unknown receipt");
    const d = await callStub(env, rm[1]!).disclose(rm[0]!);
    if (!d) throw new HttpError(404, "unknown receipt");
    return json(d);
  }
  throw new HttpError(404, "not found");
}

// ── Call Durable Object ─────────────────────────────────────────────

interface Usage { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

interface State {
  id: string;
  created: number;
  fail: FailMode | null;
  failUsed: boolean;
  plan_id: string;
  trace_id: string;
  policy_hash: string;
  seq: number;
  prev_hash: string | null;
  step: number;
  turn: number;
  messages: { role: "user" | "assistant"; content: string | Block[] }[];
  transcript: { at: string; who: string; text: string }[];
  facts: CallFacts;
  observed_request_ids: string[];
  sign_rpc_ms: number[];
  sign_us: number[];
  anchor_ms: number[];
  batches: number;
  ended: boolean;
  start_sth: { tree_size: number; root_hash: string } | null;
  last_sth: { tree_size: number; root_hash: string } | null;
  consistency_ok: boolean;
  usage: Usage;
  cost: CallCost;
  infra: { worker_requests: number; do_requests: number };
  tool_results: { name: string; turn: number; result: Record<string, unknown> }[];
  ended_at?: number;
}

interface CallCost {
  usd_total: number;
  by_model: Record<string, { usd: number; requests: number } & Usage>;
  tokens: Usage;
  unpriced_models: string[];
}

class Interrupted extends Error {}

interface QueueItem {
  seq: number;
  step: number | null;
  turn: number;
  iteration: number;
  receipt_id: string;
  leaf_hash: string;
  receipt_hash: string;
  previous: string | null;
  signed_at: number;
}

interface Span {
  span_id: string;
  parent_id: string | null;
  kind: string;
  name: string;
  start_us: number;
  dur_us: number;
  attrs: Record<string, unknown>;
  status?: string;
}

const scanner = new LeakScanner(PRIVATE_PROMPT);
const PROMPT_LINES = PRIVATE_PROMPT.split("\n").length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rid = (bytes: number) => toHex(crypto.getRandomValues(new Uint8Array(bytes)));
const pct = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const FALLBACK_LINE = "I'm sorry, I can't help with that on this line. Let me connect you with a member services specialist.";
const LEAK_LINE = "Sorry, I can't share internal details. What else can I help you with today?";

export class CallDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private s!: State;
  private eventId = 0;
  private writers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private ping?: ReturnType<typeof setInterval>;
  private busy = false;
  private current?: { ctl: AbortController; promise: Promise<void>; turn: number; iteration: number; startedAt: number; requestId: string | null };
  private queue: QueueItem[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private inflight = false;
  private authFailures = 0;
  private authInjected = 0;
  private boot?: Promise<{ issuerPem: string; issuerPub: CryptoKey; logPub: CryptoKey; issuerKeyId: string; logId: string }>;
  private enc = new TextEncoder();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ev TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (seq INTEGER PRIMARY KEY, id TEXT NOT NULL, json TEXT NOT NULL, proof TEXT, meta TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS disclosures (receipt_id TEXT PRIMARY KEY, salt TEXT NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    const row = this.sql.exec<{ v: string }>("SELECT v FROM kv WHERE k = 'state'").toArray()[0];
    if (row) {
      this.s = JSON.parse(row.v);
      // Defaults for state written by earlier versions of this Worker.
      const z = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      this.s.cost ??= { usd_total: 0, by_model: {}, tokens: { ...z }, unpriced_models: [] };
      this.s.infra ??= { worker_requests: 0, do_requests: 0 };
      this.s.tool_results ??= [];
      this.s.usage ??= { ...z };
    }
    this.eventId = this.sql.exec<{ m: number | null }>("SELECT MAX(id) AS m FROM events").one().m ?? 0;
    // Rebuild the anchor queue from receipts that have no proof yet (restart safety).
    for (const r of this.sql.exec<{ meta: string }>("SELECT meta FROM receipts WHERE proof IS NULL ORDER BY seq").toArray()) {
      this.queue.push(JSON.parse(r.meta));
    }
    if (this.queue.length) this.scheduleFlush();
  }

  private save(): void {
    this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('state', ?)", JSON.stringify(this.s));
  }

  private nowUs(): number {
    return (Date.now() - this.s.created) * 1000;
  }
  private at(): string {
    const s = Math.floor((Date.now() - this.s.created) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  // ── events ──
  private emit(ev: string, data: Record<string, unknown>): void {
    const id = ++this.eventId;
    const payload = JSON.stringify({ ...data, t_us: data.t_us ?? this.nowUs() });
    this.sql.exec("INSERT INTO events (id, ev, data) VALUES (?, ?, ?)", id, ev, payload);
    const frame = this.enc.encode(`id: ${id}\nevent: ${ev}\ndata: ${payload}\n\n`);
    for (const w of this.writers) w.write(frame).catch(() => this.writers.delete(w));
  }

  private failureSeq = 0;
  private openFailures = new Map<string, string>();

  private failure(kind: string, stage: string, o: { attempt?: number; of?: number; backoff_ms?: number; detail?: string; step?: number | null; turn?: number; iteration?: number; span_id?: string | null; injected?: boolean } = {}): void {
    // One failure_id per incident: opened at "detected", shared by its later stages.
    let fid = this.openFailures.get(kind);
    if (!fid || stage === "detected") { fid = `f-${++this.failureSeq}`; this.openFailures.set(kind, fid); }
    const state = stage === "recovered" ? "recovered" : stage === "unrecoverable" ? "failed" : "recovering";
    if (state !== "recovering") this.openFailures.delete(kind);
    this.emit("failure", { failure_id: fid, kind, stage, state, attempt: o.attempt ?? 0, of: o.of ?? 0, backoff_ms: o.backoff_ms ?? 0, detail: o.detail ?? "", step: o.step ?? null, turn: o.turn ?? null, iteration: o.iteration ?? null, span_id: o.span_id ?? null, injected: !!o.injected });
  }

  private api(target: string, method: string, path: string, status: number, ms: number, extra: Record<string, unknown> = {}): void {
    if (this.s && target !== "anthropic") this.s.infra.worker_requests++; // subrequests to signer/authority
    this.emit("api", { target, method, path, status, ms, ...extra });
  }

  async fetch(req: Request): Promise<Response> {
    // SSE stream (the only fetch route; everything else is RPC).
    if (!this.s) return json({ error: "unknown call" }, 404);
    if (this.writers.size >= MAX_SSE_CLIENTS) return json({ error: "too many listeners" }, 429, { "retry-after": "10" });
    const url = new URL(req.url);
    const last = Number(req.headers.get("last-event-id") ?? url.searchParams.get("last_event_id") ?? "0");
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const w = writable.getWriter();
    w.write(this.enc.encode(`retry: 2000\n\n`));
    for (const e of this.sql.exec<{ id: number; ev: string; data: string }>("SELECT id, ev, data FROM events WHERE id > ? ORDER BY id", Number.isFinite(last) ? last : 0)) {
      w.write(this.enc.encode(`id: ${e.id}\nevent: ${e.ev}\ndata: ${e.data}\n\n`));
    }
    this.writers.add(w);
    this.ping ??= setInterval(() => {
      const f = this.enc.encode(": ping\n\n");
      for (const x of this.writers) x.write(f).catch(() => this.writers.delete(x));
      if (!this.writers.size) { if (this.ping !== undefined) clearInterval(this.ping); this.ping = undefined; }
    }, 15_000);
    return new Response(readable, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
    });
  }

  // ── boot: signer key, issuer registration, log key, starting STH ──
  private ensureBoot() {
    this.boot ??= (async () => {
      const t0 = Date.now();
      const keyP = this.env.AUTHORITY.fetch("https://authority/authority/v1/key");
      const info = await this.env.SIGNER.info();
      this.api("signer", "RPC", "info", 200, Date.now() - t0);
      const t1 = Date.now();
      const reg = await this.env.AUTHORITY.fetch("https://authority/authority/v1/issuers", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.env.REGISTRATION_TOKEN ?? ""}` },
        body: JSON.stringify({ public_key_pem: info.public_key_pem }),
      });
      this.api("authority", "POST", "/authority/v1/issuers", reg.status, Date.now() - t1);
      const regJson = (await reg.json()) as { key_id?: string; error?: string };
      if (reg.status !== 200 || regJson.key_id !== info.key_id) throw new Error(`issuer registration failed: ${reg.status} ${regJson.error ?? ""}`);
      const keyRes = await keyP;
      this.api("authority", "GET", "/authority/v1/key", keyRes.status, Date.now() - t0);
      const key = (await keyRes.json()) as { log_id: string; public_key_pem: string };
      return { issuerPem: info.public_key_pem, issuerPub: await importPublicPem(info.public_key_pem), logPub: await importPublicPem(key.public_key_pem), issuerKeyId: info.key_id, logId: key.log_id };
    })().catch((e) => {
      this.boot = undefined;
      throw e;
    });
    return this.boot;
  }

  // ── RPC: init ──
  async init(id: string, fail: FailMode | null): Promise<void> {
    if (this.s) return;
    this.s = {
      id, created: Date.now(), fail, failUsed: false,
      plan_id: crypto.randomUUID(), trace_id: rid(16),
      policy_hash: await sha256Hex(canonicalBytes({ agent: AGENT, prompt_version: PROMPT_VERSION, rules: RULES })),
      seq: 0, prev_hash: null, step: 0, turn: 0,
      messages: [{ role: "user", content: `(Call connected. Today's date: ${new Date().toISOString().slice(0, 10)}.)` }, { role: "assistant", content: GREETING }],
      transcript: [],
      facts: { verified: false, repFound: false, dobFailures: 0 },
      observed_request_ids: [], sign_rpc_ms: [], sign_us: [], anchor_ms: [], batches: 0, ended: false,
      start_sth: null, last_sth: null, consistency_ok: true,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      cost: { usd_total: 0, by_model: {}, tokens: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, unpriced_models: [] },
      infra: { worker_requests: 1, do_requests: 1 },
      tool_results: [],
    };
    this.save();
    // Return to the client immediately; boot + greeting stream over SSE. Turns wait on this.
    this.ready = this.start(id, fail).catch((e) => {
      console.error(e);
      this.failure("boot_error", "unrecoverable", { detail: String((e as Error).message ?? e).slice(0, 200) });
    });
    this.ctx.waitUntil(this.ready);
  }

  private ready: Promise<void> = Promise.resolve();

  private async start(id: string, fail: FailMode | null): Promise<void> {
    const t0 = Date.now();
    const [boot, sthRes] = await Promise.all([
      this.ensureBoot(),
      this.env.AUTHORITY.fetch("https://authority/authority/v1/sth"),
      this.indexUpdate(),
    ]);
    this.api("authority", "GET", "/authority/v1/sth", sthRes.status, Date.now() - t0);
    const sth = ((await sthRes.json()) as { sth: { tree_size: number; root_hash: string } }).sth;
    this.s.start_sth = { tree_size: sth.tree_size, root_hash: sth.root_hash };
    this.s.last_sth = this.s.start_sth;
    this.emit("start", {
      call_id: id,
      rules: RULES,
      prompt_version: PROMPT_VERSION,
      prompt_sha256: await sha256Hex(PRIVATE_PROMPT),
      policy_hash: this.s.policy_hash,
      issuer_key_id: boot.issuerKeyId,
      issuer_public_key_pem: boot.issuerPem,
      log_id: boot.logId,
      plan_id: this.s.plan_id,
      session_id: id,
      trace_id: this.s.trace_id,
      model: MODEL,
      effort: EFFORT,
      key_isolated: true,
      key_isolation: "issuer key held only by the filet-signer Worker (no public route), reached via service binding",
      thinking_kind: "summary",
      claims_source: "model",
      fail: fail,
      anchor_start: this.s.start_sth,
    });
    const at = this.at();
    this.s.transcript.push({ at, who: "agent", text: GREETING });
    this.emit("turn", { who: "agent", at, text: GREETING, turn: 0, step: null });
    await this.sign(null, 0, 0, "disclose:ai_and_recording", {
      decision_record: { schema: "decision-record/v0", point: "disclosure", decision: "ai_and_recording_disclosed", rule_id: "DISC-0", uncertainty: "none", prompt_version: PROMPT_VERSION },
      claims_source: "scripted",
      spoken_sha256: await sha256Hex(GREETING),
    }, `rule DISC-0 (scripted greeting)`);
    this.save();
  }

  // ── RPC: turn ──
  async turn(text: string): Promise<{ status: number; body: unknown }> {
    if (!this.s) return { status: 404, body: { error: "unknown call" } };
    if (this.s.ended) return { status: 409, body: { error: "call ended" } };
    if (this.s.turn >= MAX_TURNS_PER_CALL) return { status: 429, body: { error: `max ${MAX_TURNS_PER_CALL} turns per call` } };
    this.s.infra.do_requests++;
    let interrupted: unknown = null;
    if (this.busy) interrupted = await this.interrupt("barge_in");
    if (this.busy) return { status: 409, body: { error: "previous turn did not stop in time" } };
    this.busy = true;
    await this.ready;
    const turnNo = this.s.turn + 1;
    const ctl = new AbortController();
    this.current = { ctl, promise: Promise.resolve(), turn: turnNo, iteration: 0, startedAt: Date.now(), requestId: null };
    const p = this.runTurn(text, ctl.signal)
      .catch((e) => {
        console.error(e);
        this.failure("agent_error", "unrecoverable", { detail: String((e as Error).message ?? e).slice(0, 200), turn: turnNo });
      })
      .finally(() => {
        this.busy = false;
        this.current = undefined;
        this.save();
      });
    this.current.promise = p;
    this.ctx.waitUntil(p);
    return { status: 202, body: { accepted: true, turn: turnNo, ...(interrupted ? { interrupted } : {}) } };
  }

  // ── RPC: stop (interrupt without a new line) ──
  async stop(): Promise<{ status: number; body: unknown }> {
    if (!this.s) return { status: 404, body: { error: "unknown call" } };
    if (!this.busy) return { status: 200, body: { stopped: false } };
    const r = await this.interrupt("stop");
    return { status: 200, body: { stopped: true, ...r } };
  }

  /** Abort the in-flight turn (Anthropic stream included) and wait for it to unwind. */
  private async interrupt(reason: "barge_in" | "stop"): Promise<{ turn: number; iteration: number; at_ms: number } | null> {
    const cur = this.current;
    if (!cur) return null;
    (cur as { reason?: string }).reason = reason;
    const info = { turn: cur.turn, iteration: cur.iteration, at_ms: Date.now() - cur.startedAt };
    cur.ctl.abort(new Interrupted(reason));
    await Promise.race([cur.promise, sleep(15_000)]);
    return info;
  }

  private async runTurn(text: string, signal: AbortSignal): Promise<void> {
    const s = this.s;
    const turnStarted = Date.now();
    const check = () => { if (signal.aborted) throw new Interrupted("interrupted"); };
    const turnNo = ++s.turn;
    const at = this.at();
    s.transcript.push({ at, who: "caller", text });
    this.emit("turn", { who: "caller", at, text, turn: turnNo });
    s.messages.push({ role: "user", content: `[${at}] Caller: ${text}` });
    this.save();

    const rootId = rid(8);
    const rootStart = this.nowUs();
    const spans: Span[] = [];
    let spokeThisTurn = false;
    let iterNow = 0;
    let stepNow = s.step;
    try {
    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      check();
      const step = s.step++;
      iterNow = iteration;
      stepNow = step;
      if (this.current) this.current.iteration = iteration;
      const ctx = { step, turn: turnNo, iteration };
      const span = (o: Omit<Span, "span_id"> & { span_id?: string }) => {
        const sp = { span_id: o.span_id ?? rid(8), ...o } as Span;
        spans.push(sp);
        this.emit("span", { ...ctx, ...sp });
        return sp;
      };
      this.emit("model_input", {
        ...ctx, at: this.at(), prompt_version: PROMPT_VERSION, prompt_sha256: await sha256Hex(PRIVATE_PROMPT),
        prompt_preview: `[private prompt withheld: ${PROMPT_LINES} lines, ${PRIVATE_PROMPT.length} chars; hash only]`,
        rules_in_context: Object.keys(RULES), transcript_turns: s.transcript.length, model: MODEL, effort: EFFORT,
        messages: s.messages.length,
      });

      const res = await this.callModel(ctx, rootId, span, signal);
      check();
      if (!res) {
        await this.speak(FALLBACK_LINE, ctx, "fallback_after_llm_failure");
        spokeThisTurn = true;
        break;
      }
      const { result, reqSpanId, thinkingText } = res;
      s.messages.push({ role: "assistant", content: result.content });
      for (const k of Object.keys(s.usage) as (keyof Usage)[]) s.usage[k] += result.usage[k];
      await this.addCost(ctx, result.model, result.usage, false);
      this.emit("loop", {
        ...ctx, stop_reason: result.stop_reason, input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens,
        cache_read_tokens: result.usage.cache_read_input_tokens, cache_write_tokens: result.usage.cache_creation_input_tokens,
        ms: result.ms, ttfb_ms: result.ttfb_ms, request_id: result.request_id, model: result.model,
        tool_uses: result.content.filter((b) => b.type === "tool_use").map((b) => b.name),
      });
      const toolUses = result.content.filter((b) => b.type === "tool_use");
      await this.sign(step, turnNo, iteration, "model:iteration", {
        request_id: result.request_id, message_id: result.message_id, model: result.model,
        turn: turnNo, iteration, stop_reason: result.stop_reason,
        usage: result.usage, tool_uses: toolUses.map((b) => b.name as string),
        thinking_kind: "summary", prompt_version: PROMPT_VERSION, prompt_sha256: await sha256Hex(PRIVATE_PROMPT),
        span_id: reqSpanId, traceparent: `00-${s.trace_id}-${reqSpanId}-01`,
      }, "model iteration recorded", thinkingText || undefined);

      if (result.stop_reason === "refusal") {
        const cat = (result.stop_details as { category?: string } | null)?.category ?? "unspecified";
        this.failure("refusal", "detected", { ...ctx, detail: `model declined (category: ${cat})` });
        await this.speak(FALLBACK_LINE, ctx, "fallback_after_refusal");
        this.failure("refusal", "recovered", { ...ctx, detail: "fallback line spoken; caller routed to a specialist" });
        spokeThisTurn = true;
        break;
      }

      const spoken = result.content.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("").trim();
      if (spoken) {
        await this.speak(spoken, ctx);
        spokeThisTurn = true;
      }

      if (result.stop_reason !== "tool_use" || toolUses.length === 0) break;
      const results: Block[] = [];
      for (const tu of toolUses) {
        const out = tu.name === "record_decision"
          ? await this.recordDecision(ctx, tu, result, spans, rootId, span)
          : await this.runTool(ctx, tu, rootId, span, signal);
        results.push({ type: "tool_result", tool_use_id: tu.id as string, content: JSON.stringify(out.content), ...(out.isError ? { is_error: true } : {}) });
      }
      s.messages.push({ role: "user", content: results });
      this.save();
      if (iteration === MAX_ITERATIONS) {
        this.failure("loop_limit", "unrecoverable", { ...ctx, detail: `stopped after ${MAX_ITERATIONS} model iterations` });
      }
    }
    if (!spokeThisTurn) await this.speak("Sorry, could you say that again?", { step: s.step - 1, turn: turnNo, iteration: 0 }, "no_reply");
    } catch (e) {
      if (!(e instanceof Interrupted) && !(e instanceof AnthropicError && e.interrupted)) throw e;
      // Keep the transcript valid for the next request: every tool_use needs a tool_result.
      const last = s.messages[s.messages.length - 1];
      if (last?.role === "assistant" && Array.isArray(last.content)) {
        const pending = last.content.filter((b) => b.type === "tool_use");
        if (pending.length) s.messages.push({ role: "user", content: pending.map((b) => ({ type: "tool_result", tool_use_id: b.id as string, content: JSON.stringify({ interrupted: true }), is_error: true })) });
      }
      const reason = ((this.current as { reason?: string } | undefined)?.reason) ?? "stop";
      const at_ms = Date.now() - turnStarted;
      const inflight = this.current?.requestId ?? null;
      this.emit("interrupted", { turn: turnNo, iteration: iterNow, step: stepNow, at_ms, reason, request_id: inflight });
      await this.sign(stepNow, turnNo, iterNow, "interrupted", { turn: turnNo, iteration: iterNow, at_ms, reason, request_id: inflight, spoken_before_interrupt: spokeThisTurn }, `caller ${reason === "barge_in" ? "barged in" : "stopped the turn"}`);
    }
    this.emit("span", { step: null, turn: turnNo, iteration: null, span_id: rootId, parent_id: null, kind: "turn", name: `${AGENT} turn ${turnNo}`, start_us: rootStart, dur_us: this.nowUs() - rootStart, attrs: { at, transcript_turns: s.transcript.length } });
    this.save();
  }

  /** Leak-check and emit an agent line. */
  private async speak(text: string, ctx: { step: number; turn: number; iteration: number }, source?: string): Promise<void> {
    let line = text;
    const hit = scanner.find(line);
    if (hit) {
      this.failure("leak_blocked", "detected", { ...ctx, detail: "agent reply shares a 6-word sequence with the private prompt" });
      line = LEAK_LINE;
      this.failure("leak_blocked", "recovered", { ...ctx, detail: "reply replaced with a safe line before display" });
    }
    const at = this.at();
    this.s.transcript.push({ at, who: "agent", text: line });
    this.emit("turn", { who: "agent", at, text: line, ...ctx, ...(source ? { source } : {}) });
  }

  // ── model call with staged failure handling ──
  private async callModel(
    ctx: { step: number; turn: number; iteration: number },
    rootId: string,
    span: (o: Omit<Span, "span_id"> & { span_id?: string }) => Span,
    signal: AbortSignal,
  ): Promise<{ result: StreamResult; reqSpanId: string; thinkingText: string } | null> {
    const apiKey = this.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      this.failure("llm_error", "unrecoverable", { ...ctx, detail: "ANTHROPIC_API_KEY not configured" });
      return null;
    }
    const RETRIES = 2;
    const promptSha = await sha256Hex(PRIVATE_PROMPT);
    let lastKind = "llm_error";
    for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
      const injected = this.s.fail === "llm_timeout" && !this.s.failUsed;
      if (injected) { this.s.failUsed = true; this.save(); }
      const reqSpanId = rid(8);
      const reqStart = this.nowUs();
      const guards = new Map<number, StreamGuard>();
      const leakedBlocks = new Set<number>();
      let thinking = "";
      const onLeak = (i: number) => {
        if (leakedBlocks.has(i)) return;
        leakedBlocks.add(i);
        this.failure("leak_blocked", "detected", { ...ctx, detail: "thinking summary shares a 6-word sequence with the private prompt" });
        this.failure("leak_blocked", "recovered", { ...ctx, detail: "rest of this thinking block withheld from display" });
      };
      const respStart = { v: 0 };
      try {
        const result = await streamMessage(apiKey, {
          model: MODEL,
          max_tokens: 16000,
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: EFFORT },
          cache_control: { type: "ephemeral" },
          system: [
            { type: "text", text: PRIVATE_PROMPT },
            { type: "text", text: "Rules (public, binding):\n" + Object.entries(RULES).map(([k, v]) => `${k}: ${v}`).join("\n") },
          ],
          tools: TOOLS,
          tool_choice: { type: "auto" },
          messages: this.s.messages,
        }, {
          onHeaders: (r) => { if (r) this.s.observed_request_ids.push(r); if (this.current) this.current.requestId = r; respStart.v = this.nowUs(); },
          onThinking: (i, d) => {
            thinking += d;
            let g = guards.get(i);
            if (!g) { g = scanner.stream(); guards.set(i, g); }
            const out = g.push(d);
            if (out === null) onLeak(i);
            else if (out) this.emit("thinking", { ...ctx, chunk: out, thinking_kind: "summary" });
          },
          onBlockStop: (i, b) => {
            if (b.type !== "thinking") return;
            thinking += "\n";
            const g = guards.get(i);
            if (!g) return;
            const out = g.flush();
            if (out === null) onLeak(i);
            else if (out) this.emit("thinking", { ...ctx, chunk: out, thinking_kind: "summary" });
          },
        }, injected ? 1500 : 120_000, signal);
        if (attempt > 1) this.failure(lastKind, "recovered", { ...ctx, attempt, of: RETRIES, detail: `answered on attempt ${attempt} (request ${result.request_id})` });
        this.api("anthropic", "POST", "/v1/messages", 200, result.ms, { request_id: result.request_id, ttfb_ms: result.ttfb_ms });
        span({ span_id: rid(8), parent_id: reqSpanId, kind: "llm.response", name: result.content.filter((b) => b.type !== "text" || b.text).map((b) => b.type === "tool_use" ? `tool_use:${b.name}` : b.type).join(" + ") || "empty", start_us: respStart.v, dur_us: this.nowUs() - respStart.v, attrs: { thinking_sha256: await sha256Hex(thinking), thinking_kind: "summary", output_tokens: result.usage.output_tokens, stop_reason: result.stop_reason } });
        span({ span_id: reqSpanId, parent_id: rootId, kind: "llm.request", name: "messages.create (stream)", start_us: reqStart, dur_us: this.nowUs() - reqStart, attrs: { model: result.model ?? MODEL, effort: EFFORT, prompt_sha256: promptSha, request_id: result.request_id, input_tokens: result.usage.input_tokens, cache_read_tokens: result.usage.cache_read_input_tokens, attempt } });
        return { result, reqSpanId, thinkingText: thinking.trim() };
      } catch (e) {
        const err = e instanceof AnthropicError ? e : new AnthropicError(0, String(e), null, true);
        if (err.usage) await this.addCost(ctx, err.model ?? MODEL, err.usage, true);
        if (err.interrupted || signal.aborted) {
          this.api("anthropic", "POST", "/v1/messages", 499, Math.round((this.nowUs() - reqStart) / 1000), { request_id: err.requestId, error: "aborted by caller interrupt" });
          span({ span_id: reqSpanId, parent_id: rootId, kind: "llm.request", name: "messages.create (stream)", start_us: reqStart, dur_us: this.nowUs() - reqStart, attrs: { model: MODEL, request_id: err.requestId, attempt, aborted: true }, status: "aborted" });
          throw new Interrupted("interrupted");
        }
        const kind = injected || /timeout/.test(err.message) ? "llm_timeout" : "llm_error";
        lastKind = kind;
        this.api("anthropic", "POST", "/v1/messages", err.status, Math.round((this.nowUs() - reqStart) / 1000), { request_id: err.requestId, error: err.message.slice(0, 160) });
        span({ span_id: reqSpanId, parent_id: rootId, kind: "llm.request", name: "messages.create (stream)", start_us: reqStart, dur_us: this.nowUs() - reqStart, attrs: { model: MODEL, request_id: err.requestId, attempt, error: err.message.slice(0, 120) }, status: "error" });
        this.failure(kind, "detected", { ...ctx, attempt, of: RETRIES, span_id: reqSpanId, injected, detail: (injected ? "injected: 1.5 s client deadline on a real request; " : "") + err.message.slice(0, 160) });
        await this.sign(ctx.step, ctx.turn, ctx.iteration, `error:${kind}`, { error_kind: kind, request_id: err.requestId, http_status: err.status, attempt, injected, span_id: reqSpanId, turn: ctx.turn, iteration: ctx.iteration }, `error recorded: ${kind}`);
        if (!err.retryable || attempt > RETRIES) {
          this.failure(kind, "unrecoverable", { ...ctx, attempt, of: RETRIES, detail: "giving up; fallback line spoken" });
          return null;
        }
        const backoff = 400 * 2 ** (attempt - 1);
        this.failure(kind, "retrying", { ...ctx, attempt, of: RETRIES, backoff_ms: backoff, detail: `retry ${attempt} of ${RETRIES}` });
        await sleep(backoff);
      }
    }
    return null;
  }

  // ── scenario tools ──
  private async runTool(
    ctx: { step: number; turn: number; iteration: number },
    tu: Block,
    rootId: string,
    span: (o: Omit<Span, "span_id"> & { span_id?: string }) => Span,
    signal?: AbortSignal,
  ): Promise<{ content: unknown; isError?: boolean }> {
    const name = String(tu.name);
    const input = (tu.input ?? {}) as Record<string, unknown>;
    const shown: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      shown[k] = PRIVATE_INPUT_FIELDS.includes(k) ? { hashed: "sha256:" + (await sha256Hex(String(v))).slice(0, 10) } : v;
    }
    if (scanner.findIn(shown)) {
      this.failure("leak_blocked", "detected", { ...ctx, detail: `tool input for ${name} matched the private prompt` });
      for (const k of Object.keys(shown)) if (typeof shown[k] === "string") shown[k] = "[withheld]";
      this.failure("leak_blocked", "recovered", { ...ctx, detail: "tool input strings withheld from display" });
    }
    const dispId = rid(8);
    const dispStart = this.nowUs();
    this.emit("tool_call", { ...ctx, name, input: shown, tool_use_id: tu.id });
    if (input.__invalid_json) return { content: { error: "invalid tool input JSON" }, isError: true };
    let result: Record<string, unknown> | undefined;
    const RETRIES = 2;
    for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
      const execId = rid(8);
      const execStart = this.nowUs();
      const injected = this.s.fail === "tool_error" && !this.s.failUsed;
      const { result: r, downstream } = runMockTool(name, input, this.s.facts);
      if (injected) {
        this.s.failUsed = true;
        const d = downstream[0];
        await sleep(180);
        if (d) span({ parent_id: execId, kind: "downstream.call", name: `${d.service} ${d.method} ${d.template}`, start_us: execStart, dur_us: this.nowUs() - execStart, attrs: { service: d.service, method: d.method, route: d.template, status: 503, mock: true }, status: "error" });
        span({ span_id: execId, parent_id: dispId, kind: "tool.exec", name, start_us: execStart, dur_us: this.nowUs() - execStart, attrs: { input_sha256: await sha256Hex(canonicalBytes(input)), attempt }, status: "error" });
        this.failure("tool_error", "detected", { ...ctx, attempt, of: RETRIES, span_id: execId, injected: true, detail: `injected: ${d?.service ?? name} returned 503` });
        await this.sign(ctx.step, ctx.turn, ctx.iteration, "error:tool_error", { error_kind: "tool_error", tool: name, attempt, injected: true, span_id: execId, turn: ctx.turn, iteration: ctx.iteration }, "error recorded: tool_error");
        this.failure("tool_error", "retrying", { ...ctx, attempt, of: RETRIES, backoff_ms: 300, detail: `retry ${attempt} of ${RETRIES}` });
        await sleep(300);
        continue;
      }
      for (const d of downstream) {
        const t = this.nowUs();
        await sleep(d.ms); // mock downstream latency (no real member systems behind this demo)
        if (signal?.aborted) throw new Interrupted("interrupted");
        span({ parent_id: execId, kind: "downstream.call", name: `${d.service} ${d.method} ${d.template}`, start_us: t, dur_us: this.nowUs() - t, attrs: { service: d.service, method: d.method, route: d.template, status: 200, mock: true, member_id: { hashed: "sha256:" + (await sha256Hex(String(input.member_id ?? ""))).slice(0, 10) } } });
      }
      span({ span_id: execId, parent_id: dispId, kind: "tool.exec", name, start_us: execStart, dur_us: this.nowUs() - execStart, attrs: { input_sha256: await sha256Hex(canonicalBytes(input)), attempt } });
      if (attempt > 1) this.failure("tool_error", "recovered", { ...ctx, attempt, of: RETRIES, detail: `${name} succeeded on attempt ${attempt}` });
      result = r;
      break;
    }
    span({ span_id: dispId, parent_id: rootId, kind: "tool.dispatch", name, start_us: dispStart, dur_us: this.nowUs() - dispStart, attrs: { tool: name } });
    const resStart = this.nowUs();
    this.emit("tool_result", { ...ctx, name, result, tool_use_id: tu.id });
    if (result) {
      (this.s.tool_results ??= []).push({ name, turn: ctx.turn, result });
      if (this.s.tool_results.length > 50) this.s.tool_results.shift();
    }
    span({ parent_id: rootId, kind: "tool.result", name, start_us: resStart, dur_us: 0, attrs: { result_sha256: await sha256Hex(canonicalBytes(result ?? {})) } });
    return { content: result ?? { error: "tool failed" }, isError: !result };
  }

  private async recordDecision(
    ctx: { step: number; turn: number; iteration: number },
    tu: Block,
    model: StreamResult,
    spans: Span[],
    rootId: string,
    span: (o: Omit<Span, "span_id"> & { span_id?: string }) => Span,
  ): Promise<{ content: unknown; isError?: boolean }> {
    const inp = (tu.input ?? {}) as Record<string, unknown>;
    const bad = (why: string) => ({ content: { error: `invalid record_decision: ${why}` }, isError: true });
    if (!POINTS.includes(inp.point as never)) return bad("point");
    if (!DECISIONS.includes(inp.decision as never)) return bad("decision");
    if (typeof inp.rule_id !== "string" || !(inp.rule_id in RULES)) return bad("rule_id");
    if (!UNCERTAINTY.includes(inp.uncertainty as never)) return bad("uncertainty");
    if (!Array.isArray(inp.claims)) return bad("claims");
    const rawClaims = (inp.claims as Record<string, unknown>[]).slice(0, 10).map((c, i) => ({
      id: `c${i + 1}`,
      text: String(c?.text ?? "").slice(0, 300),
      cites: (Array.isArray(c?.cites) ? (c.cites as Record<string, unknown>[]) : [])
        .slice(0, 8)
        .filter((x) => CITE_KINDS.includes(x?.kind as never))
        .map((x) => ({ kind: String(x.kind), ref: String(x.ref ?? "").slice(0, 60) })),
    }));
    // Leak scan (fail closed): any claim or the question sharing a 6-gram with the private prompt is withheld.
    let leaks = 0;
    const claims: { id: string; text: string | { withheld: string }; cites: { kind: string; ref: string; value?: unknown; resolved?: boolean }[] }[] = rawClaims.map((c) => {
      if (scanner.find(c.text)) { leaks++; return { ...c, text: { withheld: "leak_scan" } }; }
      return c;
    });
    let question: string | { withheld: string } = String(inp.question ?? "").slice(0, 300);
    if (scanner.find(question)) { leaks++; question = { withheld: "leak_scan" }; }
    if (leaks) {
      this.failure("leak_blocked", "detected", { ...ctx, detail: `${leaks} decision field(s) matched the private prompt` });
      this.failure("leak_blocked", "recovered", { ...ctx, detail: "matching fields replaced with {withheld: leak_scan} before display and signing" });
    }
    // Inline every cited value so a client can check the reasoning from the receipt alone.
    for (const c of claims) {
      c.cites = c.cites.map((x) => {
        const v = this.resolveCite(x.kind, x.ref, rawClaims);
        return v === undefined ? { ...x, value: null, resolved: false } : { ...x, value: v };
      });
    }
    const reasoning = { question, claims, decision: inp.decision, rule_id: inp.rule_id, uncertainty: inp.uncertainty };
    const decision_record = {
      schema: "decision-record/v0",
      point: inp.point, decision: inp.decision, rule_id: inp.rule_id, uncertainty: inp.uncertainty,
      prompt_version: PROMPT_VERSION, turn: ctx.turn, iteration: ctx.iteration,
      member: { hashed: "sha256:" + (await sha256Hex("NH-552019")).slice(0, 10) },
    };
    const decStart = this.nowUs();
    this.emit("decision", { ...ctx, decision_record, reasoning, claims, claims_source: "model", rule_text: RULES[inp.rule_id as string], request_id: model.request_id, tool_use_id: tu.id });
    const dec = span({ parent_id: rootId, kind: "decision", name: String(inp.point), start_us: decStart, dur_us: 0, attrs: { rule_id: inp.rule_id, decision: inp.decision } });
    const stack = await Promise.all(spans.map(async (sp) => ({
      span_id: sp.span_id, parent_id: sp.parent_id, kind: sp.kind, name: sp.name, dur_us: sp.dur_us,
      attrs_sha256: await sha256Hex(canonicalBytes(sp.attrs)), ...(sp.status ? { status: sp.status } : {}),
    })));
    const links = this.env.TRACE_URL_TEMPLATE
      ? [{ system: "otel", span_id: dec.span_id, url: this.env.TRACE_URL_TEMPLATE.replace("{trace_id}", this.s.trace_id).replace("{span_id}", dec.span_id) }]
      : undefined;
    const r = await this.sign(ctx.step, ctx.turn, ctx.iteration, `decide:${inp.point}`, {
      decision_record, reasoning, claims_source: "model",
      request_id: model.request_id, model: model.model, turn: ctx.turn, iteration: ctx.iteration,
      tools_this_turn: spans.filter((x) => x.kind === "tool.dispatch").map((x) => x.name),
      stack: { trace_id: this.s.trace_id, spans: stack },
      traceparent: `00-${this.s.trace_id}-${dec.span_id}-01`,
      ...(links ? { links } : {}),
    }, `rule ${inp.rule_id}`);
    return { content: r ? { recorded: true, receipt_id: r.receipt_id, seq: r.seq } : { recorded: false, error: "signer unavailable" }, isError: !r };
  }

  // ── hot path: sign via filet-signer, stream `signed`, queue for anchoring ──
  private async sign(
    step: number | null, turn: number, iteration: number, action: string,
    evidence: Record<string, unknown>, policyReason: string, reasoning?: string,
  ): Promise<{ receipt_id: string; seq: number } | null> {
    const s = this.s;
    const seq = s.seq + 1;
    const id = `${s.id}-r${seq}`;
    const fields: Record<string, unknown> = {
      id, type: "notarised_evidence", plan_id: s.plan_id, agent: AGENT, action,
      in_policy: true, policy_reason: policyReason, evidence,
      observed_at: isoNowUtc(), aiuc_controls: ["E015", "D003", "B001"], agent_key_id: "",
      policy_hash: s.policy_hash, session_id: s.id, seq,
    };
    if (s.prev_hash) fields.previous_receipt_hash = s.prev_hash;
    let salt: string | undefined;
    if (reasoning) {
      salt = rid(32);
      fields.reasoning_hash = await sha256Hex(`${salt}:${reasoning}`);
      fields.commitment_alg = "sha256-salted-v1";
    }
    const RETRIES = 2;
    let out: SignOut | undefined;
    let rpcMs = 0;
    let crash: { attempts: number; injected: boolean; detail: string } | undefined;
    for (let attempt = 1; attempt <= RETRIES + 1 && !out; attempt++) {
      const injected = s.fail === "signer_crash" && !s.failUsed && action.startsWith("decide:");
      if (injected) { s.failUsed = true; this.save(); }
      const t0 = Date.now();
      try {
        // Injected crash: a real RPC the signer rejects (unknown field), i.e. a real error path.
        out = await this.env.SIGNER.signReceipt(injected ? { ...fields, __crash: true } : fields);
        rpcMs = Date.now() - t0;
        if (attempt > 1) this.failure("signer_crash", "recovered", { step, turn, iteration, attempt, of: RETRIES, detail: `receipt seq ${seq} signed after restart; no sequence gap` });
      } catch (e) {
        this.api("signer", "RPC", "signReceipt", 500, Date.now() - t0, { error: String((e as Error).message).slice(0, 120) });
        this.failure("signer_crash", "detected", { step, turn, iteration, attempt, of: RETRIES, injected, detail: (injected ? "injected: " : "") + String((e as Error).message).slice(0, 160) });
        crash = { attempts: attempt, injected: injected || !!crash?.injected, detail: String((e as Error).message).slice(0, 160) };
        if (attempt > RETRIES) {
          this.failure("signer_crash", "unrecoverable", { step, turn, iteration, attempt, of: RETRIES, detail: "receipt not issued" });
          return null;
        }
        // "Restart": drop cached boot state and re-establish the signer + authority session.
        this.boot = undefined;
        try { await this.ensureBoot(); this.failure("signer_crash", "restarted", { step, turn, iteration, attempt, of: RETRIES, detail: "signer session re-established, key_id re-checked" }); } catch { /* retried below */ }
        const backoff = 200 * attempt;
        this.failure("signer_crash", "retrying", { step, turn, iteration, attempt, of: RETRIES, backoff_ms: backoff, detail: `retry ${attempt} of ${RETRIES}` });
        await sleep(backoff);
      }
    }
    if (!out) return null;
    const previous = s.prev_hash;
    s.seq = seq;
    s.prev_hash = out.receipt_hash;
    s.sign_rpc_ms.push(rpcMs);
    s.sign_us.push(out.sign_us);
    const item: QueueItem = { seq, step, turn, iteration, receipt_id: id, leaf_hash: out.leaf_hash, receipt_hash: out.receipt_hash, previous, signed_at: Date.now() };
    this.sql.exec("INSERT INTO receipts (seq, id, json, proof, meta) VALUES (?, ?, ?, NULL, ?)", seq, id, JSON.stringify(out.receipt), JSON.stringify(item));
    if (salt && reasoning) this.sql.exec("INSERT INTO disclosures (receipt_id, salt, text) VALUES (?, ?, ?)", id, salt, reasoning);
    this.save();
    this.emit("signed", {
      step, turn, iteration, seq, receipt_id: id, receipt_hash: out.receipt_hash, previous_receipt_hash: previous,
      key_id: out.receipt.key_id, signature: out.receipt.signature, sign_us: out.sign_us, hot_us: out.hot_us,
      sign_rpc_ms: rpcMs, signer: "filet-signer (service binding)", receipt: out.receipt,
    });
    this.queue.push(item);
    this.emit("queued", { step, turn, iteration, receipt_id: id, seq, leaf_hash: out.leaf_hash, queue_depth: this.queue.length });
    this.scheduleFlush();
    // The outage itself goes on the chain once the signer is back.
    if (crash && !action.startsWith("error:")) {
      await this.sign(step, turn, iteration, "error:signer_crash", { error_kind: "signer_crash", failed_attempts: crash.attempts, injected: crash.injected, detail: crash.detail, recovered_at_seq: seq, turn, iteration }, "error recorded: signer_crash");
    }
    return { receipt_id: id, seq };
  }

  // ── cold path: anchoring ──
  private scheduleFlush(delay = 250): void {
    if (this.queue.length >= 64 && !this.inflight) {
      if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      void this.flush();
      return;
    }
    this.flushTimer ??= setTimeout(() => { this.flushTimer = undefined; void this.flush(); }, delay);
  }

  private async flush(): Promise<void> {
    if (this.inflight || !this.queue.length) return;
    this.inflight = true;
    const items = this.queue.slice(0, 64);
    const sealed_t_us = this.nowUs();
    const BACKOFF = [1000, 2000, 4000, 8000, 8000];
    try {
      const boot = await this.ensureBoot();
      if (this.s.fail === "authority_down" && !this.s.failUsed) {
        this.authInjected++;
        if (this.authInjected >= 3) { this.s.failUsed = true; this.save(); }
        throw new Error("injected: authority unreachable (request not sent)");
      }
      const leaves = items.map((i) => i.leaf_hash);
      const batch_ts = isoNowUtc();
      const t0 = Date.now();
      const { batch_signature, key_id } = await this.env.SIGNER.signBatch(leaves, batch_ts);
      this.api("signer", "RPC", "signBatch", 200, Date.now() - t0, { leaves: leaves.length });
      const sent_t_us = this.nowUs();
      const t1 = Date.now();
      const res = await this.env.AUTHORITY.fetch("https://authority/authority/v1/batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key_id, leaf_hashes: leaves, batch_signature, batch_ts }),
      });
      const rtt = Date.now() - t1;
      this.api("authority", "POST", "/authority/v1/batches", res.status, rtt, { leaves: leaves.length });
      const body = (await res.json()) as Record<string, any>;
      if (res.status !== 200) throw new Error(`authority ${res.status}: ${body.error ?? ""}`);

      const delayed = this.authFailures > 0;
      if (this.authFailures > 0) {
        const fails = this.authFailures;
        const inj = this.authInjected > 0;
        queueMicrotask(() => void this.sign(null, this.s.turn, 0, "error:authority_down", { error_kind: "authority_down", failed_attempts: fails, injected: inj, recovered_batch_size: items.length, delayed_seqs: items.map((i) => i.seq) }, "error recorded: authority_down"));
        this.failure("authority_down", "recovered", { attempt: this.authFailures, of: BACKOFF.length, detail: `batch of ${items.length} anchored after ${this.authFailures} failed attempt(s)` });
        this.authFailures = 0;
      }
      this.queue.splice(0, items.length);
      this.s.batches++;
      const sth = body.sth as { tree_size: number; root_hash: string; timestamp: string };
      const batch_id = `b-${(await sha256Hex(leaves.join(""))).slice(0, 12)}`;
      this.emit("batch", {
        batch_id, leaf_hashes: leaves, seqs: items.map((i) => i.seq), sealed_t_us, sent_t_us,
        tree_size_before: body.tree_size_before, tree_size_after: body.tree_size_after, root_hash: sth.root_hash,
        sth, sth_signature: body.sth_signature, authority_ms: body.authority_ms, rtt_ms: rtt, delayed, replayed: !!body.replayed,
      });

      const sthSigOk = await edVerify(boot.logPub, body.sth_signature, canonicalBytes(sth));
      const prev = this.s.last_sth;
      this.s.last_sth = { tree_size: sth.tree_size, root_hash: sth.root_hash };
      // Append-only check runs on its own sequential chain so it never delays anchoring.
      this.consistencyChain = this.consistencyChain.then(() => this.checkConsistency(prev, sth, sthSigOk)).catch((e) => console.error(e));
      for (const [i, it] of items.entries()) {
        const proof = body.proofs[i] as Record<string, any>;
        const row = this.sql.exec<{ json: string }>("SELECT json FROM receipts WHERE seq = ?", it.seq).one();
        const receipt = JSON.parse(row.json) as Record<string, unknown>;
        this.sql.exec("UPDATE receipts SET proof = ? WHERE seq = ?", JSON.stringify(proof), it.seq);
        const anchor_ms = Date.now() - it.signed_at;
        this.s.anchor_ms.push(anchor_ms);
        this.emit("anchored", {
          step: it.step, turn: it.turn, iteration: it.iteration, seq: it.seq, receipt_id: it.receipt_id, batch_id,
          batch_size: items.length, leaf_index: proof.leaf_index, leaf_hash: proof.leaf_hash, tree_size: proof.tree_size,
          tree_size_before: body.tree_size_before, root_hash: sth.root_hash, sth, sth_signature: body.sth_signature,
          audit_path: proof.audit_path, log_id: proof.log_id, anchor_ms, delayed, log_inclusion_proof: proof,
        });
        // Independent check: re-canonicalize here (not in the signer), then verify issuer sig, leaf, path, STH sig.
        const payload = signedPayloadBytes(receipt);
        const leafOk = (await logLeafHash(payload)) === proof.leaf_hash && proof.leaf_hash === it.leaf_hash;
        const issuerOk = await edVerify(boot.issuerPub, String(receipt.signature), payload);
        const pathOk = (await walkAuditPath(proof.leaf_hash, proof.audit_path, proof.leaf_index, proof.tree_size)) === sth.root_hash;
        const hashOk = (await sha256Hex(payload)) === it.receipt_hash;
        this.emit("verified", {
          step: it.step, turn: it.turn, iteration: it.iteration, seq: it.seq, receipt_id: it.receipt_id,
          issuer: issuerOk, log: leafOk && pathOk && sthSigOk ? "passed" : "failed",
          chain_ok: hashOk && (receipt.previous_receipt_hash ?? null) === it.previous,
          verified_by: "filet-call (WebCrypto, independent canonicalization)",
        });
      }
      this.save();
    } catch (e) {
      this.authFailures++;
      const injected = /injected/.test(String((e as Error).message));
      if (this.authFailures === 1) {
        this.failure("authority_down", "detected", { attempt: 1, of: BACKOFF.length, injected, detail: String((e as Error).message).slice(0, 160) });
        this.failure("authority_down", "queued", { attempt: 1, of: BACKOFF.length, injected, detail: `${this.queue.length} leaves held in the call's queue; receipts stay signed and chained` });
      }
      const backoff = BACKOFF[Math.min(this.authFailures - 1, BACKOFF.length - 1)]!;
      if (this.authFailures <= BACKOFF.length) {
        this.failure("authority_down", "retrying", { attempt: this.authFailures, of: BACKOFF.length, backoff_ms: backoff, injected, detail: `retry ${this.authFailures} of ${BACKOFF.length} in ${backoff / 1000} s` });
      } else if (this.authFailures === BACKOFF.length + 1) {
        this.failure("authority_down", "unrecoverable", { attempt: this.authFailures, of: BACKOFF.length, detail: "authority still unreachable; retrying every 30 s in the background" });
      }
      this.inflight = false;
      if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => { this.flushTimer = undefined; void this.flush(); }, this.authFailures <= BACKOFF.length ? backoff : 30_000);
      return;
    }
    this.inflight = false;
    if (this.queue.length) this.scheduleFlush();
  }

  private consistencyChain: Promise<void> = Promise.resolve();

  private async checkConsistency(prev: { tree_size: number; root_hash: string } | null, sth: { tree_size: number; root_hash: string }, sthSigOk: boolean): Promise<void> {
    let consistent = true;
    let proofLen = 0;
    if (prev && prev.tree_size > 0 && prev.tree_size <= sth.tree_size) {
      const t2 = Date.now();
      const cr = await this.env.AUTHORITY.fetch(`https://authority/authority/v1/consistency?from=${prev.tree_size}&to=${sth.tree_size}`);
      this.api("authority", "GET", "/authority/v1/consistency", cr.status, Date.now() - t2);
      const cj = (await cr.json()) as { proof?: string[] };
      proofLen = cj.proof?.length ?? 0;
      consistent = cr.status === 200 && (await verifyConsistency(prev.tree_size, sth.tree_size, prev.root_hash, sth.root_hash, cj.proof ?? []));
    }
    this.emit("consistency", { from_size: prev?.tree_size ?? 0, to_size: sth.tree_size, ok: consistent && sthSigOk, sth_signature_ok: sthSigOk, proof_len: proofLen, checked_by: "filet-call" });
    if (!(consistent && sthSigOk)) { this.s.consistency_ok = false; this.save(); }
  }

  private async drain(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while ((this.queue.length || this.inflight) && Date.now() < deadline) {
      if (!this.inflight && !this.flushTimer) this.scheduleFlush(0);
      await sleep(50);
    }
    await Promise.race([this.consistencyChain, sleep(Math.max(0, deadline - Date.now()))]);
  }

  // ── RPC: end ──
  async end(): Promise<{ status: number; body: unknown }> {
    if (!this.s) return { status: 404, body: { error: "unknown call" } };
    if (this.s.ended) return { status: 409, body: { error: "call already ended" } };
    if (this.busy) await this.interrupt("stop");
    this.s.infra.do_requests++;
    this.s.ended = true;
    this.s.ended_at = Date.now();
    this.save();
    await this.drain(20_000);

    // Reconcile: request IDs this Worker observed in Anthropic response headers vs request IDs in receipts.
    const rows = this.sql.exec<{ json: string }>("SELECT json FROM receipts ORDER BY seq").toArray().map((r) => JSON.parse(r.json) as Record<string, any>);
    const inReceipts = new Set(rows.map((r) => r.evidence?.request_id).filter((x): x is string => typeof x === "string"));
    const observed = [...new Set(this.s.observed_request_ids)];
    const unmatched_observed = observed.filter((x) => !inReceipts.has(x));
    const unmatched_receipts = [...inReceipts].filter((x) => !observed.includes(x));
    this.emit("reconciled", {
      reconciled_against: "observed_responses",
      observed_responses: observed.length,
      matched: observed.length - unmatched_observed.length,
      unmatched_observed, unmatched_receipts,
      note: "request IDs read by filet-call from Anthropic response headers; not provider-side logs",
    });
    const counts = {
      turns: this.s.turn, model_iterations: rows.filter((r) => r.action === "model:iteration").length,
      decisions: rows.filter((r) => String(r.action).startsWith("decide:")).length,
      errors: rows.filter((r) => String(r.action).startsWith("error:")).length,
      receipts: rows.length + 1, observed_responses: observed.length, matched: observed.length - unmatched_observed.length,
    };
    await this.sign(null, this.s.turn, 0, "close", { counts, usage: this.s.usage, reconciled_against: "observed_responses" }, "chain close");
    await this.drain(20_000);

    // Local chain check over everything issued in this call.
    const all = this.sql.exec<{ json: string }>("SELECT json FROM receipts ORDER BY seq").toArray().map((r) => JSON.parse(r.json) as Record<string, unknown>);
    const boot = await this.ensureBoot();
    let valid = true;
    let prev: string | undefined;
    for (const r of all) {
      const payload = signedPayloadBytes(r);
      if (!(await edVerify(boot.issuerPub, String(r.signature), payload))) valid = false;
      if (r.previous_receipt_hash !== prev) valid = false;
      prev = await sha256Hex(payload);
    }
    const s = this.s;
    const done = {
      chain: { valid, length: all.length, rootHash: prev ?? "" },
      receipts: all.length,
      batches: s.batches,
      unanchored: this.queue.length,
      sign_us_p50: pct(s.sign_us, 0.5), sign_us_max: Math.max(0, ...s.sign_us),
      anchor_ms_p50: pct(s.anchor_ms, 0.5), anchor_ms_max: Math.max(0, ...s.anchor_ms),
      latency: {
        sign_rpc_ms_p50: pct(s.sign_rpc_ms, 0.5), sign_rpc_ms_p99: pct(s.sign_rpc_ms, 0.99), sign_rpc_ms_max: Math.max(0, ...s.sign_rpc_ms),
        anchor_ms_p50: pct(s.anchor_ms, 0.5), anchor_ms_p99: pct(s.anchor_ms, 0.99), anchor_ms_max: Math.max(0, ...s.anchor_ms),
        sign_us_note: "sign_us is measured inside filet-signer; the Workers clock does not advance during pure CPU work, so it reads 0 there. sign_rpc_ms is the measured service-binding round trip.",
      },
      consistency: { ok: s.consistency_ok, from: s.start_sth?.tree_size ?? 0, to: s.last_sth?.tree_size ?? 0 },
      usage: s.usage,
      cost: { ...s.cost, prices_as_of: PRICES.prices_as_of, infra_usd_estimate: this.infraUsd() },
    };
    this.emit("done", done);
    await this.indexUpdate();
    this.save();
    return { status: 200, body: done };
  }

  /** Value of a cite: rule text, tool result field, transcript line, or earlier claim text. */
  private resolveCite(kind: string, ref: string, claims: { id: string; text: string }[]): unknown {
    const cap = (v: unknown): unknown => {
      const j = JSON.stringify(v);
      return j && j.length > 500 ? j.slice(0, 500) + "…" : v;
    };
    if (kind === "rule") return RULES[ref.trim().toUpperCase()];
    if (kind === "claim") {
      const c = claims.find((x) => x.id === ref.trim().toLowerCase());
      return c ? (scanner.find(c.text) ? { withheld: "leak_scan" } : c.text) : undefined;
    }
    if (kind === "turn") {
      const t = this.s.transcript.filter((x) => x.at === ref.trim());
      const line = t.find((x) => x.who === "caller") ?? t[0];
      return line ? `${line.who === "caller" ? "Caller" : "Ava"} (${line.at}): ${line.text}` : undefined;
    }
    if (kind === "tool") {
      let tool: string | undefined;
      let key = ref.trim();
      const dot = key.indexOf(".");
      if (dot > 0 && this.s.tool_results.some((t) => t.name === key.slice(0, dot))) { tool = key.slice(0, dot); key = key.slice(dot + 1); }
      const find = (o: unknown): unknown => {
        if (!o || typeof o !== "object") return undefined;
        if (!Array.isArray(o) && key in (o as Record<string, unknown>)) return (o as Record<string, unknown>)[key];
        // FHIR extension: { url: key, value[x]: ... }
        if (!Array.isArray(o) && (o as Record<string, unknown>).url === key) {
          const vk = Object.keys(o).find((k) => k.startsWith("value"));
          if (vk) return (o as Record<string, unknown>)[vk];
        }
        for (const v of Object.values(o)) { const f = find(v); if (f !== undefined) return f; }
        return undefined;
      };
      for (const t of [...this.s.tool_results].reverse()) {
        if (tool && t.name !== tool) continue;
        const v = find(t.result);
        if (v !== undefined) return cap(v);
      }
    }
    return undefined;
  }

  // ── RPC: evidence package ──
  async package(authorityOrigin: string): Promise<unknown> {
    if (!this.s) return null;
    const boot = await this.ensureBoot();
    const receipts = this.sql.exec<{ json: string; proof: string | null }>("SELECT json, proof FROM receipts ORDER BY seq").toArray()
      .map((r) => ({ ...JSON.parse(r.json), ...(r.proof ? { log_inclusion_proof: JSON.parse(r.proof) } : {}) }));
    const keyRes = await this.env.AUTHORITY.fetch("https://authority/authority/v1/key");
    const key = (await keyRes.json()) as { log_id: string; public_key_pem: string };
    const sth = await (await this.env.AUTHORITY.fetch("https://authority/authority/v1/sth")).json();
    return {
      call_id: this.s.id,
      started_at: new Date(this.s.created).toISOString(),
      ended_at: this.s.ended_at ? new Date(this.s.ended_at).toISOString() : null,
      agent: AGENT,
      prompt_version: PROMPT_VERSION,
      policy_hash: this.s.policy_hash,
      rules: Object.entries(RULES).map(([id, text]) => ({ id, text })),
      transcript: this.s.transcript,
      receipts,
      unanchored: receipts.filter((r) => !r.log_inclusion_proof).length,
      authority: { origin: authorityOrigin, log_id: key.log_id, public_key_pem: key.public_key_pem, sth },
      issuer_public_key_pem: boot.issuerPem,
      issuer_key_id: boot.issuerKeyId,
      cost: { ...this.s.cost, prices_as_of: PRICES.prices_as_of },
      verify: "verifyAerfReceipt(receipt, { issuerPublicKey: issuer_public_key_pem, logPublicKey: authority.public_key_pem }) and verifyAerfChain(receipts) from the AgentMint SDK",
    };
  }

  // ── cost tracking ──
  private infraUsd(): number {
    const i = this.s.infra;
    return Math.round(((i.worker_requests * INFRA_PRICES.workers_per_million_requests + i.do_requests * INFRA_PRICES.durable_object_per_million_requests) / 1e6) * 1e8) / 1e8;
  }

  private async addCost(ctx: { step: number; turn: number; iteration: number }, model: string | null | undefined, usage: Usage, partial: boolean): Promise<void> {
    const c = this.s.cost;
    const m = priceFor(model)?.key ?? (model || "unknown");
    if (!priceFor(model) && !c.unpriced_models.includes(m)) c.unpriced_models.push(m);
    const usd = usdFor(model, usage);
    const b = (c.by_model[m] ??= { usd: 0, requests: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    b.requests++;
    b.usd = Math.round((b.usd + usd) * 1e6) / 1e6;
    for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
      b[k] += usage[k];
      c.tokens[k] += usage[k];
    }
    c.usd_total = Math.round((c.usd_total + usd) * 1e6) / 1e6;
    this.emit("cost", { ...ctx, model: model ?? m, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_read_tokens: usage.cache_read_input_tokens, cache_write_tokens: usage.cache_creation_input_tokens, usage, usd, ...(partial ? { partial: true } : {}), prices_as_of: PRICES.prices_as_of });
    const tokTotal = c.tokens.input_tokens + c.tokens.output_tokens + c.tokens.cache_read_input_tokens + c.tokens.cache_creation_input_tokens;
    this.emit("call_cost", { usd: c.usd_total, usd_total: c.usd_total, by_model: c.by_model, tokens: tokTotal, tokens_by_kind: c.tokens, prices_as_of: PRICES.prices_as_of, infra_usd_estimate: this.infraUsd() });
    this.save();
    await this.indexUpdate();
  }

  private async indexUpdate(): Promise<void> {
    try {
      const idx = this.env.CALL_INDEX.get(this.env.CALL_INDEX.idFromName("index")) as unknown as CallIndexRpc;
      await idx.upsert({ id: this.s.id, started_at: new Date(this.s.created).toISOString(), turns: this.s.turn, usd_total: this.s.cost.usd_total, by_model: this.s.cost.by_model, ended: this.s.ended });
    } catch (e) {
      console.error("call index update failed", e);
    }
  }

  // ── RPC: disclose ──
  async disclose(receiptId: string): Promise<{ receipt_id: string; salt: string; text: string; commitment_alg: string } | null> {
    const row = this.sql.exec<{ salt: string; text: string }>("SELECT salt, text FROM disclosures WHERE receipt_id = ?", receiptId).toArray()[0];
    return row ? { receipt_id: receiptId, salt: row.salt, text: row.text, commitment_alg: "sha256-salted-v1" } : null;
  }
}

// ── Cost index: one small DO listing recent calls and their totals ──

interface CallRow { id: string; started_at: string; turns: number; usd_total: number; by_model: unknown; ended: boolean }
interface CallIndexRpc {
  upsert(row: CallRow): Promise<void>;
  list(limit: number): Promise<CallRow[]>;
}

export class CallIndex extends DurableObject<Env> {
  private sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, turns INTEGER NOT NULL, usd_total REAL NOT NULL, by_model TEXT NOT NULL, ended INTEGER NOT NULL)");
  }
  async upsert(r: CallRow): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO calls (id, started_at, turns, usd_total, by_model, ended) VALUES (?, ?, ?, ?, ?, ?)", r.id, r.started_at, r.turns, r.usd_total, JSON.stringify(r.by_model), r.ended ? 1 : 0);
    // Keep the table small.
    this.sql.exec("DELETE FROM calls WHERE id NOT IN (SELECT id FROM calls ORDER BY started_at DESC LIMIT 1000)");
  }
  async list(limit: number): Promise<CallRow[]> {
    return this.sql
      .exec<{ id: string; started_at: string; turns: number; usd_total: number; by_model: string; ended: number }>("SELECT * FROM calls ORDER BY started_at DESC LIMIT ?", Math.min(100, limit))
      .toArray()
      .map((r) => ({ id: r.id, started_at: r.started_at, turns: r.turns, usd_total: r.usd_total, by_model: JSON.parse(r.by_model), ended: !!r.ended }));
  }
}
