// Signer process: the only place the issuer private key exists.
//
// Owns plans, per-plan seq / previous-hash chain state, and an append-only
// write-ahead log (WAL) so a crash resumes the chain with no gap. Serves
// length-prefixed JSON frames on a unix domain socket (pipelined requests).
// Cold path: batches leaf hashes to the authority every FLUSH_MS or MAX_BATCH
// leaves, signs each batch once, and streams proofs back as notifications.
//
// Env: SIGNER_SOCKET, SIGNER_STATE_DIR, AUTHORITY_URL, ISSUER_PRIVATE_KEY_PEM
// (optional; else a key file in the state dir), ANCHOR_FLUSH_MS, ANCHOR_MAX_BATCH.
import { createServer, type Socket } from "node:net";
import { createPublicKey, sign as edSign, verify as edVerify, createPublicKey as pubFromPem, type KeyObject } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { canonicalBytes, canonicalize, rawNumber, sha256Hex } from "../src/kernel/canonical.js";
import { generateKeyPair, keyId, privateKeyFromPem, privateKeyToPem, publicKeyToPem } from "../src/kernel/sign.js";
import { buildAerfSignable, isoNowUtc, type LogInclusionProof } from "../src/receipt-aerf.js";
import { computePolicyHash, evaluatePolicy, signPlan, type PlanInit, type PlanReceipt } from "../src/plan.js";
import { logLeafHash } from "../src/merkle.js";
import { frameReader, writeFrame } from "./frames.js";
import { verifyConsistency } from "./log.js";
import { authorityBase, batchDigest, type BatchResponse, type Sth } from "./authority.js";

const SOCKET = must("SIGNER_SOCKET");
const STATE = must("SIGNER_STATE_DIR");
// AUTHORITY_URL is the authority origin; the API lives under /authority/v1/... (CONTRACT).
const AUTHORITY = authorityBase(must("AUTHORITY_URL"));
const FLUSH_MS = Number(process.env.ANCHOR_FLUSH_MS ?? 250);
const MAX_BATCH = Number(process.env.ANCHOR_MAX_BATCH ?? 64);
const WAL_PATH = join(STATE, "wal.jsonl");
const DONE_CAP = 20_000;

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

// ── Key (never leaves this process) ─────────────────────────────────

mkdirSync(STATE, { recursive: true, mode: 0o700 });
const key: KeyObject = loadKey();
delete process.env.ISSUER_PRIVATE_KEY_PEM;
const pub = createPublicKey(key);
const KEY_ID = keyId(pub);
const PUBLIC_PEM = publicKeyToPem(pub);

function loadKey(): KeyObject {
  if (process.env.ISSUER_PRIVATE_KEY_PEM) return privateKeyFromPem(process.env.ISSUER_PRIVATE_KEY_PEM);
  const p = join(STATE, "issuer_key.pem");
  if (existsSync(p)) return privateKeyFromPem(readFileSync(p, "utf8"));
  const k = generateKeyPair().privateKey;
  writeFileSync(p, privateKeyToPem(k), { mode: 0o600 });
  return k;
}

// ── State + WAL ─────────────────────────────────────────────────────

interface Chain { seq: number; prev?: string }
interface Pending { leaf: string; receipt_id: string; plan_id: string; seq: number; queued_ns: string; delayed?: boolean }
interface Signed { receipt: Record<string, unknown>; chain_hash: string; leaf_hash: string }

const plans = new Map<string, { plan: PlanReceipt; policyHash: string }>();
const chains = new Map<string, Chain>();
const done = new Map<string, Signed>();
const unanchored = new Map<string, Pending>();
let resumed = { plans: 0, receipts: 0, unanchored: 0 };

function replay(): void {
  if (!existsSync(WAL_PATH)) return;
  const text = readFileSync(WAL_PATH, "utf8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      break; // torn tail write from a crash: everything before it is intact
    }
    if (e.t === "p") {
      const plan = e.plan as PlanReceipt;
      plans.set(plan.id, { plan, policyHash: computePolicyHash(plan) });
      if (!chains.has(plan.id)) chains.set(plan.id, { seq: 0 });
      resumed.plans++;
    } else if (e.t === "c") {
      chains.set(e.plan_id as string, { seq: e.seq as number, prev: e.h as string | undefined });
    } else if (e.t === "r") {
      // Signed payload + signature; evidence is omitted from replies (the agent re-attaches it).
      const { evidence: _e, ...head } = e.p as Record<string, unknown>;
      const r: Record<string, unknown> = { ...head, signature: e.s as string };
      chains.set(r.plan_id as string, { seq: r.seq as number, prev: e.h as string });
      remember(e.k as string, { receipt: r, chain_hash: e.h as string, leaf_hash: e.l as string });
      unanchored.set(e.l as string, {
        leaf: e.l as string, receipt_id: r.id as string, plan_id: r.plan_id as string, seq: r.seq as number,
        queued_ns: process.hrtime.bigint().toString(), delayed: true,
      });
      resumed.receipts++;
    } else if (e.t === "a") {
      for (const l of e.leaves as string[]) unanchored.delete(l);
    } else if (e.t === "x") {
      plans.delete(e.plan_id as string);
    }
  }
  resumed.unanchored = unanchored.size;
}

function remember(k: string, s: Signed): void {
  done.set(k, s);
  if (done.size > DONE_CAP) done.delete(done.keys().next().value as string);
}

/** Rewrite the WAL to live state only (open plans, chain heads, unanchored receipts). */
function compact(): void {
  if (!existsSync(WAL_PATH) || statSync(WAL_PATH).size < 32 << 20) return;
  const lines: string[] = [];
  for (const { plan } of plans.values()) lines.push(JSON.stringify({ t: "p", plan }));
  for (const [plan_id, c] of chains) if (plans.has(plan_id)) lines.push(JSON.stringify({ t: "c", plan_id, seq: c.seq, h: c.prev }));
  const tmp = `${WAL_PATH}.tmp`;
  writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600 });
  renameSync(tmp, WAL_PATH);
}

replay();
compact();
const wal = openSync(WAL_PATH, "a", 0o600);
const walLine = (o: unknown) => writeSync(wal, JSON.stringify(o) + "\n");

// ── Ops ─────────────────────────────────────────────────────────────

function openPlan(init: PlanInit & { id: string }): PlanReceipt {
  const have = plans.get(init.id);
  if (have) return have.plan; // idempotent re-send after a restart
  const plan = signPlan(init, key);
  plans.set(plan.id, { plan, policyHash: computePolicyHash(plan) });
  chains.set(plan.id, { seq: 0 });
  walLine({ t: "p", plan });
  return plan;
}

interface SignReq {
  k: string;
  plan_id: string;
  action: string;
  agent: string;
  evidence: Record<string, unknown>;
  reasoning_hash?: string;
  context_hash?: string;
  commitment_alg?: string;
}

function signOne(m: SignReq): Signed & { sign_us: number; queue_depth: number; replay?: boolean } {
  const prior = done.get(m.k);
  if (prior) return { ...prior, sign_us: 0, queue_depth: queue.length, replay: true };
  const t0 = process.hrtime.bigint();
  const p = plans.get(m.plan_id);
  if (!p) throw new Error(`unknown plan ${m.plan_id}`);
  const chain = chains.get(m.plan_id)!;
  const ev = evaluatePolicy(m.action, m.agent, p.plan);
  // Canonicalize the evidence ONCE and splice it in verbatim: the size check,
  // evidence_hash_sha512 and the signed payload all reuse these bytes.
  const evidenceJson = canonicalize(m.evidence);
  const signable = buildAerfSignable(
    {
      planId: p.plan.id,
      agent: m.agent,
      action: m.action,
      inPolicy: ev.inPolicy,
      policyReason: ev.reason,
      evidence: rawNumber(evidenceJson) as unknown as Record<string, unknown>,
      previousReceiptHash: chain.prev,
      seq: chain.seq + 1,
      planSignature: p.plan.signature,
      policyHash: p.policyHash,
      reasoningHash: m.reasoning_hash,
      contextHashSha256: m.context_hash,
      commitmentAlg: m.commitment_alg,
    },
    KEY_ID,
  );
  // The same payload bytes are signed, chain-hashed and log-leafed.
  const payloadJson = canonicalize(signable);
  const payload = Buffer.from(payloadJson, "utf8");
  const signature = edSign(null, payload, key).toString("hex");
  const chain_hash = sha256Hex(payload);
  const leaf_hash = logLeafHash(payload);
  chain.prev = chain_hash;
  chain.seq += 1;
  // WAL line embeds the canonical payload verbatim (no re-stringify of the receipt).
  writeSync(wal, `{"t":"r","k":${JSON.stringify(m.k)},"h":"${chain_hash}","l":"${leaf_hash}","s":"${signature}","p":${payloadJson}}\n`);
  const { evidence: _spliced, ...head } = signable;
  const s: Signed = { receipt: { ...head, signature }, chain_hash, leaf_hash };
  remember(m.k, s);
  const sign_us = Number((process.hrtime.bigint() - t0) / 1000n);
  enqueue({ leaf: leaf_hash, receipt_id: head.id as string, plan_id: p.plan.id, seq: chain.seq, queued_ns: process.hrtime.bigint().toString() });
  return { ...s, sign_us, queue_depth: queue.length };
}

// ── Cold path: batching to the authority ────────────────────────────

const queue: Pending[] = [];
let timer: NodeJS.Timeout | undefined;
let inflight = false;
let attempt = 0;
let failUntil = 0;
let registered = false;
let lastSth: { sth: Sth } | undefined;
let logKey: KeyObject | undefined;
let batchSeq = 0;

const agentOpts = { keepAlive: true, maxSockets: 4 };
const httpAgent = new http.Agent(agentOpts);
const httpsAgent = new https.Agent(agentOpts);

interface ApiCtx {
  plans: string[];
  receipt_ids?: string[];
  batch_id?: number;
}

const short = (h: unknown) => (typeof h === "string" ? `${h.slice(0, 12)}…` : String(h));

function summarizeRequest(path: string, body: unknown): string {
  const b = body as Record<string, unknown> | undefined;
  if (path === "/v1/issuers") return "{ public_key_pem: <Ed25519 SPKI> }";
  if (path === "/v1/batches") {
    const n = Array.isArray(b?.leaf_hashes) ? b!.leaf_hashes.length : 0;
    return `{ key_id: ${String(b?.key_id)}, leaf_hashes: [${n} × sha256], batch_signature: ${short(b?.batch_signature)} }`;
  }
  return "";
}

function summarizeResponse(path: string, status: number, json: unknown): string {
  const j = json as Record<string, unknown> | undefined;
  if (status !== 200) return String(j?.error ?? `HTTP ${status}`);
  const sth = j?.sth as Sth | undefined;
  if (path === "/v1/key") return `{ log_id: ${String(j?.log_id)}, public_key_pem: <Ed25519 SPKI> }`;
  if (path === "/v1/issuers") return `{ key_id: ${String(j?.key_id)} }`;
  if (path === "/v1/sth") return `{ tree_size: ${sth?.tree_size}, root_hash: ${short(sth?.root_hash)} }`;
  if (path === "/v1/batches") {
    const proofs = Array.isArray(j?.proofs) ? j!.proofs.length : 0;
    return `{ proofs: [${proofs}], sth: { tree_size: ${sth?.tree_size}, root_hash: ${short(sth?.root_hash)} }, sth_signature: ${short(j?.sth_signature)} }`;
  }
  if (path.startsWith("/v1/consistency")) {
    return `{ from: ${String(j?.from)}, to: ${String(j?.to)}, proof: [${Array.isArray(j?.proof) ? j!.proof.length : 0} hashes] }`;
  }
  return "";
}

/** An authority HTTP call, reported to the agent side as an `api` notification. */
async function request(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  ctx: ApiCtx = { plans: [] },
): Promise<{ status: number; json: unknown }> {
  const t0 = process.hrtime.bigint();
  const report = (status: number, response_summary: string) =>
    broadcast({
      ev: "api",
      method,
      url: AUTHORITY + path,
      request_summary: summarizeRequest(path.split("?")[0]!, body),
      status,
      response_summary,
      ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10,
      ...ctx,
    });
  try {
    const res = await rawRequest(method, path, body);
    const bid = (res.json as { batch_id?: unknown } | undefined)?.batch_id;
    if (typeof bid === "number") ctx = { ...ctx, batch_id: bid };
    report(res.status, summarizeResponse(path.split("?")[0]!, res.status, res.json));
    return res;
  } catch (err) {
    report(Number((err as { status?: number }).status ?? 0), err instanceof Error ? err.message : String(err));
    throw err;
  }
}

function rawRequest(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  if (Date.now() < failUntil) return Promise.reject(Object.assign(new Error("authority unavailable (injected)"), { status: 503 }));
  const url = new URL(AUTHORITY + path);
  const lib = url.protocol === "https:" ? https : http;
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method,
        agent: url.protocol === "https:" ? httpsAgent : httpAgent,
        headers: data ? { "content-type": "application/json", "content-length": data.length } : {},
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let json: unknown = undefined;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            /* non-JSON error body */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("authority request timed out")));
    req.on("error", reject);
    req.end(data);
  });
}

async function ensureRegistered(ctx: ApiCtx = { plans: [] }): Promise<void> {
  if (registered) return;
  if (!logKey) {
    const k = await request("GET", "/v1/key", undefined, ctx);
    if (k.status !== 200) throw new Error(`GET /v1/key -> ${k.status}`);
    logKey = pubFromPem((k.json as { public_key_pem: string }).public_key_pem);
  }
  const r = await request("POST", "/v1/issuers", { public_key_pem: PUBLIC_PEM }, ctx);
  if (r.status !== 200) throw new Error(`POST /v1/issuers -> ${r.status}`);
  registered = true;
  if (!lastSth) {
    // Start consistency checks from the log's current signed head.
    const s = await request("GET", "/v1/sth", undefined, ctx);
    const head = s.json as { sth?: Sth; sth_signature?: string } | undefined;
    if (s.status === 200 && head?.sth && head.sth_signature &&
        edVerify(null, canonicalBytes(head.sth), logKey, Buffer.from(head.sth_signature, "hex"))) {
      lastSth = { sth: head.sth };
    }
  }
}

function enqueue(p: Pending): void {
  queue.push(p);
  schedule();
}

function schedule(delay = FLUSH_MS): void {
  if (inflight || timer || queue.length === 0) return;
  timer = setTimeout(flush, queue.length >= MAX_BATCH ? 0 : delay);
}

async function flush(): Promise<void> {
  timer = undefined;
  if (inflight || queue.length === 0) return;
  inflight = true;
  const items = queue.splice(0, MAX_BATCH);
  const sealed_ns = process.hrtime.bigint().toString();
  const leaf_hashes = items.map((i) => i.leaf);
  const batch_signature = edSign(null, batchDigest(leaf_hashes), key).toString("hex");
  const ctx: ApiCtx = { plans: [...new Set(items.map((i) => i.plan_id))], receipt_ids: items.map((i) => i.receipt_id) };
  let sent_ns = sealed_ns;
  try {
    await ensureRegistered(ctx);
    sent_ns = process.hrtime.bigint().toString();
    let res = await request("POST", "/v1/batches", { key_id: KEY_ID, leaf_hashes, batch_signature }, ctx);
    if (res.status === 403) {
      registered = false; // authority restarted and forgot us
      await ensureRegistered(ctx);
      res = await request("POST", "/v1/batches", { key_id: KEY_ID, leaf_hashes, batch_signature }, ctx);
    }
    if (res.status !== 200) throw Object.assign(new Error(`POST /v1/batches -> ${res.status}`), { status: res.status });
    const done_ns = process.hrtime.bigint().toString();
    const b = res.json as Partial<BatchResponse> & { proofs: LogInclusionProof[]; sth: Sth; sth_signature: string };
    if (!logKey || !edVerify(null, canonicalBytes(b.sth), logKey, Buffer.from(b.sth_signature, "hex"))) {
      throw new Error("authority STH signature invalid");
    }
    const delayed = attempt > 0 || items.some((i) => i.delayed);
    attempt = 0;
    batchSeq += 1;
    const tree_size_before = b.tree_size_before ?? b.proofs[0]?.leaf_index ?? b.sth.tree_size - items.length;
    walLine({ t: "a", leaves: leaf_hashes });
    for (const i of items) unanchored.delete(i.leaf);
    const batch_id = b.batch_id ?? batchSeq;
    broadcast({
      ev: "batch",
      batch_id,
      leaf_hashes,
      items: items.map((i, n) => ({ ...i, proof: b.proofs[n] })),
      sealed_ns,
      sent_ns,
      done_ns,
      tree_size_before,
      sth: b.sth,
      sth_signature: b.sth_signature,
      delayed,
    });
    const prev = lastSth;
    lastSth = { sth: b.sth };
    void checkConsistency(prev?.sth, b.sth, batch_id, items);
  } catch (err) {
    attempt += 1;
    for (const i of items) i.delayed = true;
    queue.unshift(...items);
    broadcast({ ev: "anchor_failure", attempt, error: err instanceof Error ? err.message : String(err), plans: [...new Set(items.map((i) => i.plan_id))] });
    inflight = false;
    timer = setTimeout(flush, Math.min(100 * 2 ** (attempt - 1), 5000));
    return;
  }
  inflight = false;
  schedule(queue.length >= MAX_BATCH ? 0 : FLUSH_MS);
}

async function checkConsistency(prev: Sth | undefined, next: Sth, batch_id: number, items: Pending[]): Promise<void> {
  const plansIn = [...new Set(items.map((i) => i.plan_id))];
  if (!prev || prev.tree_size === 0) {
    broadcast({ ev: "consistency", batch_id, from_size: 0, to_size: next.tree_size, ok: true, plans: plansIn });
    return;
  }
  let ok = false;
  try {
    const r = await request("GET", `/v1/consistency?from=${prev.tree_size}&to=${next.tree_size}`, undefined, { plans: plansIn, batch_id });
    const proof = (r.json as { proof?: string[] })?.proof;
    ok = r.status === 200 && Array.isArray(proof) && verifyConsistency(prev.tree_size, next.tree_size, prev.root_hash, next.root_hash, proof);
  } catch {
    ok = false;
  }
  broadcast({ ev: "consistency", batch_id, from_size: prev.tree_size, to_size: next.tree_size, ok, plans: plansIn });
}

// ── Socket server ───────────────────────────────────────────────────

const clients = new Set<Socket>();
function broadcast(msg: unknown): void {
  for (const c of clients) writeFrame(c, msg);
}

function handle(sock: Socket, m: { id: number; op: string; [k: string]: unknown }): void {
  try {
    let out: unknown;
    switch (m.op) {
      case "sign":
        out = signOne(m as unknown as SignReq);
        break;
      case "hello":
        out = { key_id: KEY_ID, public_key_pem: PUBLIC_PEM, pid: process.pid, resumed, now: isoNowUtc() };
        break;
      case "open_plan":
        out = { plan: openPlan(m.init as PlanInit & { id: string }) };
        break;
      case "close_plan":
        if (plans.delete(m.plan_id as string)) {
          chains.delete(m.plan_id as string);
          walLine({ t: "x", plan_id: m.plan_id });
        }
        out = {};
        break;
      case "fail_authority":
        failUntil = Date.now() + Number(m.ms ?? 0);
        out = { until: failUntil };
        break;
      default:
        throw new Error(`unknown op ${m.op}`);
    }
    writeFrame(sock, { id: m.id, ok: true, ...(out as object) });
  } catch (err) {
    writeFrame(sock, { id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// JIT warm-up of the hot path before serving (dummy payloads; never stored or sent).
{
  const dummy = signPlan({ user: "warmup", action: "warmup", scope: ["decide:*"], ttlSeconds: 60 }, key);
  const ph = computePolicyHash(dummy);
  const evidence = { decision_record: { point: "warmup", n: 1 }, stack: { trace_id: "0".repeat(32), spans: [{ span_id: "1".repeat(16), parent_id: null, kind: "turn", name: "turn 0", dur_us: 1, attrs_sha256: "2".repeat(64) }] } };
  for (let i = 0; i < 400; i++) {
    const ev = evaluatePolicy("decide:warmup", "w", dummy);
    const s = buildAerfSignable({ planId: dummy.id, agent: "w", action: "decide:warmup", inPolicy: ev.inPolicy, policyReason: ev.reason, evidence, seq: i + 1, policyHash: ph }, KEY_ID);
    const payload = canonicalBytes(s);
    JSON.stringify({ ...s, signature: edSign(null, payload, key).toString("hex"), h: sha256Hex(payload), l: logLeafHash(payload) });
  }
}

if (existsSync(SOCKET)) unlinkSync(SOCKET);
const server = createServer((sock) => {
  clients.add(sock);
  sock.on("data", frameReader((m) => handle(sock, m as { id: number; op: string })));
  sock.on("close", () => clients.delete(sock));
  sock.on("error", () => clients.delete(sock));
});
server.listen(SOCKET);

// Re-queue receipts the WAL shows as signed but never anchored.
for (const p of unanchored.values()) queue.push(p);
schedule();

// Keep-warm tick: keeps the CPU out of deep idle between receipts, which
// otherwise dominates IPC wake-up latency on small VMs (busy-polling was
// measured and made the tail worse on a 4-vCPU host, so it is not offered).
const warmMs = Number(process.env.SIGNER_KEEPWARM_MS ?? 1);
if (warmMs > 0) setInterval(() => undefined, warmMs);

// Exit with the parent: stdin closes when the parent goes away.
process.stdin.on("end", () => shutdown());
process.stdin.on("error", () => shutdown());
process.stdin.resume();
process.on("SIGTERM", () => shutdown());
function shutdown(): void {
  try {
    closeSync(wal);
  } catch {
    /* already closed */
  }
  server.close();
  try {
    unlinkSync(SOCKET);
  } catch {
    /* gone */
  }
  process.exit(0);
}
