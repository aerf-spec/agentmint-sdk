// Load harness for the signer hot path and the anchoring cold path. Used by
// `npm run loadtest` and the load test. Measures agent-side hot-path latency
// (IPC round trip to the signer process, including framing) and authority
// anchor latency, and checks zero loss: every receipt signed, anchored,
// verified, and the chain intact.
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey } from "node:crypto";
import { Authority } from "./authority.js";
import { SignerClient, type BatchEvent } from "./signer.js";
import { verifyAerfReceipt } from "../src/receipt-aerf.js";
import { verifyAerfChain } from "../src/chain.js";

export interface Stats {
  p50: number;
  p99: number;
  max: number;
}

export function pct(xs: number[]): Stats {
  if (xs.length === 0) return { p50: 0, p99: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
  return { p50: at(0.5), p99: at(0.99), max: s[s.length - 1]! };
}

export interface Harness {
  signer: SignerClient;
  authority: Authority;
  authorityUrl: string;
  server: Server;
  stateDir: string;
  close(): Promise<void>;
}

/** Local authority on an ephemeral port + a signer process pointed at it. */
export async function startHarness(opts: { stateDir?: string } = {}): Promise<Harness> {
  const authority = new Authority();
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    void authority.handle(req, res, u.pathname.replace(/^\/authority/, ""), u.searchParams);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const authorityUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "filet-bench-"));
  const signer = await SignerClient.start({ authorityUrl, stateDir });
  return {
    signer,
    authority,
    authorityUrl,
    server,
    stateDir,
    async close() {
      signer.stop();
      await new Promise((r) => server.close(r));
      if (!opts.stateDir) rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/** Decision-sized evidence: record + a 9-span stack, like the scripted call. */
export function sampleEvidence(i: number): Record<string, unknown> {
  const kinds = ["turn", "llm.request", "llm.response", "tool.dispatch", "tool.exec", "downstream.call", "tool.result", "decision", "downstream.call"];
  return {
    decision_record: { schema: "decision-record/v0", point: "visits_remaining", decision: "remaining_2_flagged", rule_id: "BEN-2", uncertainty: "conflicting_counts", evidence: [{ at: "00:30", speaker: "caller" }, { at: "00:36", speaker: "tool" }], member_id: { sha256: "a".repeat(64) } },
    claims_sha256: "b".repeat(64),
    claim_cites: [{ id: "c1", cites: [{ kind: "tool", ref: "lookup_benefits.usage[1].visits" }] }],
    stack: {
      trace_id: "c".repeat(32),
      spans: kinds.map((kind, n) => ({ span_id: n.toString(16).padStart(16, "0"), parent_id: n ? "0".repeat(16) : null, kind, name: `${kind} ${i}`, dur_us: 1000 + n, attrs_sha256: "d".repeat(64), status: "ok", attempt: 1 })),
    },
    llm_request_ids: [`req_${i}`],
    traceparent: `00-${"c".repeat(32)}-${"0".repeat(15)}1-01`,
  };
}

export interface LoadResult {
  mode: string;
  count: number;
  signed: number;
  anchored: number;
  verified: number;
  chain_valid: boolean;
  lost: number;
  hot_path_us: Stats;
  sign_us: Stats;
  anchor_ms: Stats;
  batches: number;
  wall_ms: number;
}

/** Sign `count` receipts at `rate`/s (or all at once when rate is 0) and wait for anchoring. */
export async function runLoad(h: Harness, opts: { count: number; rate: number; label?: string }): Promise<LoadResult> {
  const { signer } = h;
  const logPub = createPublicKey(h.authority.publicKeyPem);
  const issuerPub = createPublicKey(signer.publicKeyPem);
  const plan = await signer.openPlan({ user: "bench", action: "bench", scope: ["decide:*"], ttlSeconds: 3600 });
  const receipts = new Map<string, { r: Record<string, unknown>; t: bigint }>();
  const anchoredById = new Map<string, Record<string, unknown>>();
  const hot: number[] = [];
  const sign: number[] = [];
  const anchor: number[] = [];
  let verified = 0;
  const batchIds = new Set<number>();
  let resolveAll: () => void = () => undefined;
  const allAnchored = new Promise<void>((r) => (resolveAll = r));
  const onBatch = (b: BatchEvent) => {
    for (const it of b.items) {
      if (it.plan_id !== plan.id) continue;
      const rec = receipts.get(it.receipt_id);
      if (!rec) continue;
      batchIds.add(b.batch_id);
      const a = { ...rec.r, log_inclusion_proof: it.proof };
      anchoredById.set(it.receipt_id, a);
      anchor.push(Number(BigInt(b.done_ns) - rec.t) / 1e6);
      if (verifyAerfReceipt(a, { issuerPublicKey: issuerPub, logPublicKey: logPub, requireLog: true }).ok) verified++;
    }
    if (anchoredById.size >= opts.count) resolveAll();
  };
  signer.on("batch", onBatch);
  const start = process.hrtime.bigint();
  const one = async (i: number) => {
    const t0 = process.hrtime.bigint();
    const res = await signer.sign({ plan_id: plan.id, action: "decide:visits_remaining", agent: "bench", evidence: sampleEvidence(i) });
    const t1 = process.hrtime.bigint();
    hot.push(Number(t1 - t0) / 1000);
    sign.push(res.sign_us);
    receipts.set(res.receipt.id as string, { r: res.receipt, t: t1 });
  };
  const inflight: Promise<void>[] = [];
  if (opts.rate > 0) {
    const gapNs = BigInt(Math.round(1e9 / opts.rate));
    for (let i = 0; i < opts.count; i++) {
      const due = start + gapNs * BigInt(i);
      const wait = Number(due - process.hrtime.bigint()) / 1e6;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      inflight.push(one(i));
    }
  } else {
    for (let i = 0; i < opts.count; i++) inflight.push(one(i));
  }
  await Promise.all(inflight);
  await Promise.race([allAnchored, new Promise((r) => setTimeout(r, 60_000))]);
  signer.off("batch", onBatch);
  const chain = [...anchoredById.values()].sort((a, b) => Number(a.seq) - Number(b.seq));
  const chainRes = verifyAerfChain(chain, { issuerPublicKey: issuerPub });
  return {
    mode: opts.label ?? (opts.rate > 0 ? `${opts.rate}/s` : "burst"),
    count: opts.count,
    signed: receipts.size,
    anchored: anchoredById.size,
    verified,
    chain_valid: chainRes.valid && chainRes.length === opts.count,
    lost: opts.count - verified,
    hot_path_us: round(pct(hot)),
    sign_us: round(pct(sign)),
    anchor_ms: round(pct(anchor)),
    batches: batchIds.size,
    wall_ms: Math.round(Number(process.hrtime.bigint() - start) / 1e6),
  };
}

function round(s: Stats): Stats {
  const r = (x: number) => Math.round(x * 10) / 10;
  return { p50: r(s.p50), p99: r(s.p99), max: r(s.max) };
}
