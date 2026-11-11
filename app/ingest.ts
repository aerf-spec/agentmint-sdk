// "Bring your own agent" ingest API (docs/BYO-AGENT.md, v1).
//
// A customer's agent runs in its own environment on any model and posts only
// what it decided and why: salted commitments of its thinking, hashes of its
// tool I/O, and the decision with cited claims. It never sends its prompt or
// raw thinking. The platform signs each record through the signer process
// (hot path), anchors it in the transparency log (cold path, batched), and
// serves an evidence package an auditor verifies with the SDK.
//
//   POST /v1/sessions                 open a session (signed plan)
//   POST /v1/sessions/:id/records     one record → one signed, chained receipt
//   POST /v1/sessions/:id/close       close receipt + evidence package (waits ≤ 10 s for anchoring)
//   GET  /v1/sessions/:id/package     evidence package
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalBytes, sha256Hex } from "../src/kernel/canonical.js";
import { isoNowUtc, type LogInclusionProof } from "../src/receipt-aerf.js";
import { SALTED_COMMITMENT_ALG } from "../src/commitments.js";
import { authorityBase, type Sth } from "./authority.js";
import type { BatchEvent, SignerClient } from "./signer.js";

type R = Record<string, unknown>;

export const MAX_BODY_BYTES = 32 * 1024;
export const CLOSE_WAIT_MS = 10_000;
export const RAW_IP_FIELDS = ["prompt", "system", "thinking", "reasoning_text"] as const;
const MAX_RECORDS_PER_SESSION = 5_000;
const MAX_OPEN_SESSIONS = 1_000;
const MAX_SESSIONS = 5_000;
const IDLE_MS = 60 * 60_000;
const SCOPE = ["model:*", "tool:*", "decide:*", "error:*", "close:*"];
const PLAN_TTL_S = 3600;

export interface IngestOptions {
  signer: SignerClient;
  authorityUrl: string;
  logKey: { log_id: string; public_key_pem: string };
  /** Accepted Bearer keys (INGEST_API_KEYS). */
  apiKeys: readonly string[];
  /** Accept the bypass key `test` (ALLOW_TEST_KEY=1). */
  allowTestKey: boolean;
  closeWaitMs?: number;
}

/** Parse INGEST_API_KEYS / ALLOW_TEST_KEY. ALLOW_TEST_KEY defaults on (local demo); set it to 0 in production. */
export function ingestAuthFromEnv(env: NodeJS.ProcessEnv = process.env): { apiKeys: string[]; allowTestKey: boolean } {
  return {
    apiKeys: (env.INGEST_API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean),
    allowTestKey: (env.ALLOW_TEST_KEY ?? "1") === "1",
  };
}

// ── Validation ──────────────────────────────────────────────────────

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: R = {}) {
    super(message);
  }
}

const bad = (msg: string): never => {
  throw new HttpError(400, msg);
};
const HEX64 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const isObj = (v: unknown): v is R => typeof v === "object" && v !== null && !Array.isArray(v);

/** True if any object key anywhere in `v` is a raw-IP field name (case-insensitive). */
export function findRawIpField(v: unknown, depth = 0): string | undefined {
  if (depth > 32) return undefined;
  if (Array.isArray(v)) {
    for (const x of v) {
      const f = findRawIpField(x, depth + 1);
      if (f) return f;
    }
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if ((RAW_IP_FIELDS as readonly string[]).includes(k.toLowerCase())) return k;
      const f = findRawIpField(x, depth + 1);
      if (f) return f;
    }
  }
  return undefined;
}

function obj(v: unknown, path: string, required: readonly string[], optional: readonly string[] = []): R {
  if (!isObj(v)) bad(`${path} must be an object`);
  const o = v as R;
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) bad(`unknown field ${path}.${k}`);
  for (const k of required) if (o[k] === undefined) bad(`missing field ${path}.${k}`);
  return o;
}

function str(v: unknown, path: string, max = 256, re?: RegExp): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) bad(`${path} must be a string of 1..${max} chars`);
  if (re && !re.test(v as string)) bad(`${path} is malformed`);
  return v as string;
}

function int(v: unknown, path: string, min: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) bad(`${path} must be an integer >= ${min}`);
  return v as number;
}

function num(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) bad(`${path} must be a number >= 0`);
  return v as number;
}

interface SessionInit {
  agent: string;
  model: string;
  prompt_version: string;
  prompt_sha256: string;
  rules: Record<string, string>;
}

function parseSessionInit(body: unknown): SessionInit {
  const o = obj(body, "body", ["agent", "model", "prompt_version", "prompt_sha256", "rules"]);
  const rulesIn = obj(o.rules, "rules", Object.keys(isObj(o.rules) ? o.rules : {}));
  const ids = Object.keys(rulesIn);
  if (ids.length === 0 || ids.length > 200) bad("rules must hold 1..200 entries");
  const rules: Record<string, string> = {};
  for (const id of ids) {
    str(id, "rule id", 64, NAME);
    rules[id] = str(rulesIn[id], `rules.${id}`, 4000);
  }
  return {
    agent: str(o.agent, "agent", 256),
    model: str(o.model, "model", 256),
    prompt_version: str(o.prompt_version, "prompt_version", 128),
    prompt_sha256: str(o.prompt_sha256, "prompt_sha256", 64, HEX64),
    rules,
  };
}

type Cite = { kind: "rule" | "tool" | "turn" | "claim"; ref: string; value: string | number | boolean | null; resolved?: false };
type Claim = { id: string; text: string; cites: Cite[] };

/** A validated record, turned into the receipt action + evidence (+ optional commitment). */
interface Parsed {
  kind: string;
  action: string;
  evidence: R;
  reasoning_hash?: string;
}

function parseRecord(body: unknown, s: Session): Parsed {
  if (!isObj(body)) bad("body must be an object");
  const kind = (body as R).kind;
  const COMMON = ["kind", "turn", "iteration"];
  const at = (o: R) => ({ turn: int(o.turn, "turn", 0), iteration: int(o.iteration, "iteration", 1) });
  switch (kind) {
    case "model_iteration": {
      const o = obj(body, "body", [...COMMON, "model", "stop_reason"], ["request_id", "usage", "reasoning_commitment"]);
      let usage: R | undefined;
      if (o.usage !== undefined) {
        const u = obj(o.usage, "usage", ["input_tokens", "output_tokens"]);
        usage = { input_tokens: int(u.input_tokens, "usage.input_tokens", 0), output_tokens: int(u.output_tokens, "usage.output_tokens", 0) };
      }
      const commitment = o.reasoning_commitment === undefined ? undefined : str(o.reasoning_commitment, "reasoning_commitment", 64, HEX64);
      return {
        kind,
        action: "model:iteration",
        reasoning_hash: commitment,
        evidence: {
          ...at(o),
          model: str(o.model, "model", 256),
          ...(o.request_id !== undefined ? { request_id: str(o.request_id, "request_id", 256) } : {}),
          stop_reason: str(o.stop_reason, "stop_reason", 64),
          ...(usage ? { usage } : {}),
          thinking_kind: commitment ? "committed" : "none",
          prompt_version: s.init.prompt_version,
          prompt_sha256: s.init.prompt_sha256,
        },
      };
    }
    case "tool_call": {
      const o = obj(body, "body", [...COMMON, "name", "input_sha256", "result_sha256", "ms"]);
      const name = str(o.name, "name", 64, NAME);
      return {
        kind,
        action: `tool:${name}`,
        evidence: {
          ...at(o),
          name,
          input_sha256: str(o.input_sha256, "input_sha256", 64, HEX64),
          result_sha256: str(o.result_sha256, "result_sha256", 64, HEX64),
          // Canonical JSON (JCS subset) carries integers only: wall time is rounded to whole ms.
          ms: Math.round(num(o.ms, "ms")),
        },
      };
    }
    case "decision": {
      const o = obj(body, "body", [...COMMON, "decision_record", "reasoning"]);
      const t = at(o);
      const d = obj(o.decision_record, "decision_record", ["point", "decision", "rule_id", "uncertainty"]);
      const point = str(d.point, "decision_record.point", 64, NAME);
      const decision = str(d.decision, "decision_record.decision", 128);
      const rule_id = str(d.rule_id, "decision_record.rule_id", 64);
      const uncertainty = str(d.uncertainty, "decision_record.uncertainty", 64);
      if (!Object.hasOwn(s.init.rules, rule_id)) throw new HttpError(400, "unknown_rule_id", { rule_id });
      const r = obj(o.reasoning, "reasoning", ["question", "claims"]);
      const question = str(r.question, "reasoning.question", 2000);
      if (!Array.isArray(r.claims) || r.claims.length > 32) bad("reasoning.claims must be an array of ≤ 32 claims");
      const seen = new Map<string, string>();
      const claims: Claim[] = (r.claims as unknown[]).map((c, i) => {
        const co = obj(c, `reasoning.claims[${i}]`, ["id", "text", "cites"]);
        const id = str(co.id, `claims[${i}].id`, 64, NAME);
        if (seen.has(id)) bad(`duplicate claim id ${id}`);
        const text = str(co.text, `claims[${i}].text`, 2000);
        if (!Array.isArray(co.cites) || co.cites.length > 16) bad(`claims[${i}].cites must be an array of ≤ 16 cites`);
        const cites = (co.cites as unknown[]).map((x, j): Cite => {
          const p = `claims[${i}].cites[${j}]`;
          const xo = obj(x, p, ["kind", "ref", "value"]);
          const ck = xo.kind;
          if (ck !== "rule" && ck !== "tool" && ck !== "turn" && ck !== "claim") bad(`${p}.kind must be rule|tool|turn|claim`);
          const ref = str(xo.ref, `${p}.ref`, 256);
          const v = xo.value;
          if (!(v === null || typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 2000))) {
            bad(`${p}.value must be a string (≤ 2000), number, boolean or null`);
          }
          // The platform resolves what it can: rule text from the session's rules,
          // an earlier claim's text. Tool / turn values stay as the agent reported them.
          if (ck === "rule") {
            const text = s.init.rules[ref];
            return Object.hasOwn(s.init.rules, ref) && text !== undefined ? { kind: ck, ref, value: text } : { kind: ck, ref, value: null, resolved: false };
          }
          if (ck === "claim") {
            const text = seen.get(ref);
            return text !== undefined ? { kind: ck, ref, value: text } : { kind: ck, ref, value: null, resolved: false };
          }
          // Canonical JSON carries integers only: a fractional value is kept as its decimal string.
          const value = typeof v === "number" && !Number.isSafeInteger(v) ? String(v) : (v as Cite["value"]);
          return { kind: ck as "tool" | "turn", ref, value };
        });
        seen.set(id, text);
        return { id, text, cites };
      });
      return {
        kind,
        action: `decide:${point}`,
        evidence: {
          decision_record: { schema: "decision-record/v0", point, decision, rule_id, uncertainty, prompt_version: s.init.prompt_version, ...t },
          reasoning: { question, claims, decision, rule_id, uncertainty },
          claims_source: "agent",
          model: s.init.model,
          ...t,
        },
      };
    }
    case "error": {
      const o = obj(body, "body", [...COMMON, "error_kind"], ["detail"]);
      const error_kind = str(o.error_kind, "error_kind", 64, NAME);
      return {
        kind,
        action: `error:${error_kind}`,
        evidence: { error_kind, ...(o.detail !== undefined ? { detail: str(o.detail, "detail", 2000) } : {}), ...at(o) },
      };
    }
    default:
      return bad("kind must be one of model_iteration, tool_call, decision, error");
  }
}

// ── Sessions ────────────────────────────────────────────────────────

interface Session {
  id: string;
  owner: string; // sha256 of the API key that opened it
  init: SessionInit;
  policyHash: string;
  planId: string;
  startedAt: string;
  endedAt?: string;
  closed: boolean;
  closing?: Promise<R>;
  receipts: R[]; // by seq - 1
  proofs: Map<string, LogInclusionProof>;
  inflight: Set<Promise<unknown>>;
  counts: Record<string, number>;
  lastSeen: number;
  waiters: Set<() => void>;
}

export class Ingest {
  private readonly sessions = new Map<string, Session>();
  private readonly byReceipt = new Map<string, Session>();
  private readonly keyHashes: Buffer[];
  private readonly reaper: NodeJS.Timeout;
  private lastSth?: Sth;

  constructor(private readonly o: IngestOptions) {
    this.keyHashes = o.apiKeys.filter(Boolean).map(digest);
    if (o.allowTestKey) this.keyHashes.push(digest("test"));
    o.signer.on("batch", this.onBatch);
    this.reaper = setInterval(() => this.reap(), 60_000);
    this.reaper.unref();
  }

  stop(): void {
    this.o.signer.off("batch", this.onBatch);
    clearInterval(this.reaper);
  }

  /** Handle a request under /v1/sessions. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    try {
      const owner = this.auth(req);
      const m = req.method ?? "GET";
      if (path === "/v1/sessions") {
        if (m !== "POST") throw new HttpError(405, "method not allowed");
        return send(res, 201, await this.open(owner, await readBody(req)));
      }
      const route = /^\/v1\/sessions\/([0-9a-f-]{36})\/(records|close|package)$/.exec(path);
      if (!route) throw new HttpError(404, "not found");
      const s = this.sessions.get(route[1]!);
      if (!s || s.owner !== owner) throw new HttpError(404, "unknown session");
      s.lastSeen = Date.now();
      const op = route[2];
      if (op === "package") {
        if (m !== "GET") throw new HttpError(405, "method not allowed");
        return send(res, 200, await this.package(s));
      }
      if (m !== "POST") throw new HttpError(405, "method not allowed");
      const body = await readBody(req);
      if (op === "records") return send(res, 201, await this.record(s, body));
      obj(body, "body", []);
      return send(res, 200, await this.close(s));
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private auth(req: IncomingMessage): string {
    const h = req.headers.authorization ?? "";
    const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
    if (!m) throw new HttpError(401, "missing or malformed Authorization: Bearer <key>");
    const d = digest(m[1]!);
    let ok = false;
    for (const k of this.keyHashes) ok = timingSafeEqual(k, d) || ok;
    if (!ok) throw new HttpError(401, "invalid api key");
    return d.toString("hex");
  }

  private async open(owner: string, body: unknown): Promise<R> {
    const init = parseSessionInit(body);
    if ([...this.sessions.values()].filter((s) => !s.closed).length >= MAX_OPEN_SESSIONS) {
      throw new HttpError(503, "too many open sessions");
    }
    const id = randomUUID();
    const plan = await this.o.signer.openPlan({
      user: `byo:${init.agent}`,
      action: "byo-agent:session",
      scope: SCOPE,
      delegatesTo: [init.agent],
      ttlSeconds: PLAN_TTL_S,
    });
    const s: Session = {
      id,
      owner,
      init,
      // Same definition as the live backend: sha256 of canonical { agent, prompt_version, rules }.
      policyHash: sha256Hex(canonicalBytes({ agent: init.agent, prompt_version: init.prompt_version, rules: init.rules })),
      planId: plan.id,
      startedAt: isoNowUtc(),
      closed: false,
      receipts: [],
      proofs: new Map(),
      inflight: new Set(),
      counts: { model_iteration: 0, tool_call: 0, decision: 0, error: 0 },
      lastSeen: Date.now(),
      waiters: new Set(),
    };
    this.sessions.set(id, s);
    return {
      session_id: id,
      issuer_key_id: this.o.signer.keyId,
      issuer_public_key_pem: this.o.signer.publicKeyPem,
      log_public_key_pem: this.o.logKey.public_key_pem,
      policy_hash: s.policyHash,
    };
  }

  private async record(s: Session, body: unknown): Promise<R> {
    if (s.closed) throw new HttpError(409, "session closed");
    if (s.receipts.length + s.inflight.size >= MAX_RECORDS_PER_SESSION) throw new HttpError(429, "session record limit reached");
    const p = parseRecord(body, s);
    s.counts[p.kind] = (s.counts[p.kind] ?? 0) + 1;
    const res = await this.sign(s, p.action, p.evidence, p.reasoning_hash);
    return { receipt_id: res.receipt.id, seq: res.receipt.seq, receipt_hash: res.chain_hash };
  }

  private sign(s: Session, action: string, evidence: R, reasoning_hash?: string) {
    const p = this.o.signer
      .sign({
        plan_id: s.planId,
        action,
        agent: s.init.agent,
        evidence: { ...evidence, session_id: s.id },
        reasoning_hash,
        commitment_alg: reasoning_hash ? SALTED_COMMITMENT_ALG : undefined,
      })
      .then((r) => {
        const id = r.receipt.id as string;
        s.receipts[(r.receipt.seq as number) - 1] = r.receipt;
        this.byReceipt.set(id, s);
        return r;
      });
    s.inflight.add(p);
    void p.finally(() => s.inflight.delete(p)).catch(() => undefined);
    return p;
  }

  private close(s: Session): Promise<R> {
    s.closing ??= (async () => {
      s.closed = true;
      await Promise.allSettled([...s.inflight]);
      const receipts = s.receipts.filter(Boolean).length;
      await this.sign(s, "close:session", {
        counts: { ...s.counts, receipts: receipts + 1 },
        prompt_version: s.init.prompt_version,
        prompt_sha256: s.init.prompt_sha256,
        policy_hash: s.policyHash,
        model: s.init.model,
      });
      s.endedAt = isoNowUtc();
      await this.waitAnchored(s, this.o.closeWaitMs ?? CLOSE_WAIT_MS);
      void this.o.signer.closePlan(s.planId).catch(() => undefined);
      return this.package(s);
    })();
    return s.closing;
  }

  private waitAnchored(s: Session, ms: number): Promise<void> {
    const done = () => s.receipts.every((r) => !r || s.proofs.has(r.id as string));
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        s.waiters.delete(check);
        resolve();
      };
      const check = () => {
        if (done()) finish();
      };
      const timer = setTimeout(finish, ms);
      s.waiters.add(check);
    });
  }

  private readonly onBatch = (b: BatchEvent): void => {
    this.lastSth = b.sth;
    const touched = new Set<Session>();
    for (const it of b.items) {
      const s = this.byReceipt.get(it.receipt_id);
      if (!s) continue;
      s.proofs.set(it.receipt_id, it.proof);
      touched.add(s);
    }
    for (const s of touched) for (const w of [...s.waiters]) w();
  };

  private async package(s: Session): Promise<R> {
    const receipts = s.receipts.filter(Boolean).map((r) => {
      const proof = s.proofs.get(r.id as string);
      return proof ? { ...r, log_inclusion_proof: proof } : r;
    });
    let sth: unknown = this.lastSth ?? null;
    try {
      const res = await fetch(`${authorityBase(this.o.authorityUrl)}/v1/sth`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) sth = await res.json();
    } catch {
      // fall back to the last tree head seen in a batch
    }
    return {
      call_id: s.id,
      session_id: s.id,
      started_at: s.startedAt,
      ended_at: s.endedAt ?? null,
      agent: s.init.agent,
      model: s.init.model,
      prompt_version: s.init.prompt_version,
      prompt_sha256: s.init.prompt_sha256,
      policy_hash: s.policyHash,
      rules: Object.entries(s.init.rules).map(([id, text]) => ({ id, text })),
      receipts,
      unanchored: receipts.filter((r) => !("log_inclusion_proof" in r)).length,
      authority: { origin: authorityBase(this.o.authorityUrl), log_id: this.o.logKey.log_id, public_key_pem: this.o.logKey.public_key_pem, sth },
      issuer_public_key_pem: this.o.signer.publicKeyPem,
      issuer_key_id: this.o.signer.keyId,
      verify:
        "verifyAerfReceipt(receipt, { issuerPublicKey: issuer_public_key_pem, logPublicKey: authority.public_key_pem, requireLog: true }) and verifyAerfChain(receipts) from the AgentMint SDK",
    };
  }

  private reap(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.inflight.size > 0 || s.closing && !s.endedAt) continue;
      if (now - s.lastSeen > IDLE_MS || (this.sessions.size > MAX_SESSIONS && s.closed)) {
        if (!s.closed) void this.o.signer.closePlan(s.planId).catch(() => undefined);
        this.sessions.delete(id);
        for (const r of s.receipts) if (r) this.byReceipt.delete(r.id as string);
      }
    }
  }
}

// ── HTTP helpers ────────────────────────────────────────────────────

function digest(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Read a JSON body (≤ 32 KB). Raw-IP field names anywhere → 400 raw_ip_rejected. */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? NaN);
  if (declared > MAX_BODY_BYTES) {
    req.resume();
    throw new HttpError(413, `body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY_BYTES) throw new HttpError(413, `body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let body: unknown;
  try {
    body = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  const raw = findRawIpField(body);
  if (raw) throw new HttpError(400, "raw_ip_rejected", { field: raw });
  return body;
}
