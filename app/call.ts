// One scripted call, end to end: run the agent under tracing, issue a signed
// receipt per decision / failure / close through the signer process (hot
// path), and follow anchoring + verification as it arrives (cold path).
// Emits every CONTRACT event through `emit`; transport-agnostic (SSE or tests).
import { createPublicKey } from "node:crypto";
import { canonicalize } from "../src/kernel/canonical.js";
import { aerfChainHash, isoNowUtc, verifyAerfReceipt } from "../src/receipt-aerf.js";
import { verifyAerfChain } from "../src/chain.js";
import { newSalt, saltedCommitment, saltedContextCommitment, SALTED_COMMITMENT_ALG, type Disclosure } from "../src/commitments.js";
import { collectTraceLinks, formatTraceparent, type TraceLinkPlugin } from "./links.js";
import { traceCall, traceTurn, type CallHooks, type Failure, type ReceiptRequest } from "./trace.js";
import { AGENT, PROMPT_VERSION, RULES, SCRIPT, STEPS, buildAgent, type Faults, type Turn } from "./scenario.js";
import { checkIntegrity, reconcile, type Integrity, type Reconciliation } from "./integrity.js";
import { auditPathSides, verifyConsistency } from "./log.js";
import { authorityBase, type Sth } from "./authority.js";
import type { BatchEvent, SignerClient } from "./signer.js";
import type { MockProvider } from "./mock.js";
import { sha256Hex } from "../src/kernel/canonical.js";

export const FAILURE_KINDS = ["llm_timeout", "tool_error", "authority_down", "signer_crash"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

type R = Record<string, unknown>;

/** Vendor-side store of commitment openings (salts + private text), by receipt id. */
export class DisclosureStore {
  private readonly map = new Map<string, Disclosure & { claims?: { salt: string; canonical: string }; fields_salt?: string }>();
  constructor(private readonly cap = 5000) {}
  put(d: Disclosure & { claims?: { salt: string; canonical: string }; fields_salt?: string }): void {
    this.map.set(d.receipt_id, d);
    if (this.map.size > this.cap) this.map.delete(this.map.keys().next().value as string);
  }
  get(id: string) {
    return this.map.get(id);
  }
}

export interface CallOptions {
  speed: number;
  failures?: ReadonlySet<FailureKind>;
  signer: SignerClient;
  logPublicKeyPem: string;
  logId: string;
  /** Authority origin (its API is under /authority/v1). */
  authorityUrl: string;
  emit: (event: string, data: Record<string, unknown>) => void;
  aborted?: () => boolean;
  links?: TraceLinkPlugin[];
  disclosures?: DisclosureStore;
  anchorTimeoutMs?: number;
  authorityDownMs?: number;
  /** Tests: observe the mock provider (e.g. to make an un-wrapped call). */
  onProvider?: (p: MockProvider, rawClient: MockProvider["client"]) => void | Promise<void>;
}

export interface CallResult {
  plan_id: string;
  receipts: R[];
  integrity: Integrity;
  reconciliation: Reconciliation;
  done: Record<string, unknown>;
}

function pct(xs: number[]): { p50: number; p99: number; max: number } {
  if (xs.length === 0) return { p50: 0, p99: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
  return { p50: at(0.5), p99: at(0.99), max: s[s.length - 1]! };
}
const r1 = (x: number) => Math.round(x * 10) / 10;

export async function runCall(o: CallOptions): Promise<CallResult> {
  const failures = o.failures ?? new Set<FailureKind>();
  const speed = Math.min(10, Math.max(0.25, o.speed || 1));
  const t0 = process.hrtime.bigint();
  const tUs = (ns = process.hrtime.bigint()) => Number((ns - t0) / 1000n);
  const emit = (event: string, data: Record<string, unknown>) =>
    o.emit(event, { ...data, t_us: tUs(), wall: new Date().toISOString() });
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms / speed));

  const signer = o.signer;
  const plan = await signer.openPlan({
    user: "payer:northgate/member-services",
    action: "member-line:call",
    scope: ["decide:*", "error:*", "close:*"],
    delegatesTo: [AGENT],
    ttlSeconds: 3600,
  });
  const issuerPub = createPublicKey(signer.publicKeyPem);
  const logPub = createPublicKey(o.logPublicKeyPem);

  const held: R[] = [];
  const meta = new Map<string, { step: number | null; seq: number; signedNs: bigint; receipt: R }>();
  const pending = new Set<string>();
  let wake: (() => void) | undefined;
  const issuing = new Set<Promise<unknown>>();
  const stats = { hot: [] as number[], sign: [] as number[], rtt: [] as number[], anchor: [] as number[] };
  const batchIds = new Set<number>();
  const sths: Sth[] = [];
  const stepFailures = new Map<number, Failure[]>();
  let currentStep: number | null = null;
  let currentAt = "";
  let authorityFailing = false;
  let crashBeforeSign = failures.has("signer_crash");

  // ── Hot path: issue one receipt ─────────────────────────────────
  async function issue(
    action: string,
    evidence: R,
    step: number | null,
    extra: { reasoning_hash?: string; context_hash?: string; startedNs?: bigint; disclosure?: Omit<Disclosure, "receipt_id"> & R } = {},
  ): Promise<R> {
    const started = extra.startedNs ?? process.hrtime.bigint();
    const p = signer.sign({
      plan_id: plan.id,
      action,
      agent: AGENT,
      evidence,
      reasoning_hash: extra.reasoning_hash,
      context_hash: extra.context_hash,
      commitment_alg: extra.reasoning_hash || extra.context_hash ? SALTED_COMMITMENT_ALG : undefined,
    });
    if (crashBeforeSign && step === 3 && action.startsWith("decide:")) {
      // Injected: the signer dies with this request in flight. The client
      // respawns it and re-sends; the WAL keeps seq and chain continuous.
      crashBeforeSign = false;
      signer.crash();
    }
    const res = await p;
    const now = process.hrtime.bigint();
    const hot_path_us = Number((now - started) / 1000n);
    const receipt = res.receipt;
    const seq = receipt.seq as number;
    held[seq - 1] = receipt;
    meta.set(receipt.id as string, { step, seq, signedNs: now, receipt });
    pending.add(receipt.id as string);
    stats.hot.push(hot_path_us);
    stats.sign.push(res.sign_us);
    stats.rtt.push(res.rtt_us);
    if (extra.disclosure) o.disclosures?.put({ receipt_id: receipt.id as string, ...extra.disclosure });
    emit("signed", {
      step,
      seq,
      receipt_id: receipt.id,
      receipt_hash: res.chain_hash,
      previous_receipt_hash: receipt.previous_receipt_hash ?? null,
      key_id: receipt.key_id,
      signature: receipt.signature,
      sign_us: res.sign_us,
      hot_path_us,
      ipc_rtt_us: res.rtt_us,
      receipt,
    });
    emit("queued", { step, receipt_id: receipt.id, seq, leaf_hash: res.leaf_hash, queue_depth: res.queue_depth });
    return receipt;
  }

  function track<T>(p: Promise<T>): Promise<T> {
    issuing.add(p);
    void p.finally(() => issuing.delete(p)).catch(() => undefined);
    return p;
  }

  /** Evidence + salted commitments for a decision or error receipt. */
  function signStep(req: ReceiptRequest): Promise<R> {
    const rSalt = newSalt();
    const cSalt = newSalt();
    const clSalt = newSalt();
    const reasoning_hash = req.thinking ? saltedCommitment(rSalt, req.thinking) : undefined;
    const ctx = saltedContextCommitment(cSalt, req.context);
    const claimsCanonical = req.claims.length ? canonicalize(req.claims) : undefined;
    const request_id = req.request_ids[0];
    const trace = { trace_id: req.trace_id, span_id: req.root.span_id, ...(request_id ? { request_id } : {}) };
    const evidence: R = {
      ...(req.kind === "decision" ? { decision_record: req.record } : { error: req.error }),
      ...(claimsCanonical
        ? {
            claims_sha256: saltedCommitment(clSalt, claimsCanonical),
            claim_cites: req.claims.map((c) => ({ id: c.id, cites: c.cites })),
          }
        : {}),
      stack: { trace_id: req.trace_id, spans: req.stack },
      llm_request_ids: req.request_ids,
      traceparent: formatTraceparent(trace),
      links: collectTraceLinks(o.links ?? [], { ...trace, started_at: isoNowUtc() }),
    };
    const action = req.kind === "decision" ? `decide:${String(req.record?.point ?? "unknown")}` : `error:${req.error?.kind ?? "error"}`;
    return track(
      issue(action, evidence, req.step, {
        reasoning_hash,
        context_hash: ctx.hash,
        startedNs: req.started_ns,
        disclosure: {
          ...(req.thinking ? { reasoning: { salt: rSalt, text: req.thinking } } : {}),
          context: { salt: cSalt, canonical: ctx.canonical },
          ...(claimsCanonical ? { claims: { salt: clSalt, canonical: claimsCanonical } } : {}),
          fields_salt: req.salt,
        },
      }),
    );
  }

  // ── Cold path: anchoring results from the signer ────────────────
  const onBatch = (b: BatchEvent) => {
    const mine = b.items.filter((i) => i.plan_id === plan.id);
    if (mine.length === 0) return;
    batchIds.add(b.batch_id);
    sths.push(b.sth);
    const authority_ms = r1(Number(BigInt(b.done_ns) - BigInt(b.sent_ns)) / 1e6);
    emit("batch", {
      batch_id: b.batch_id,
      batch_size: b.leaf_hashes.length,
      leaf_hashes: b.leaf_hashes,
      seqs: b.items.map((i) => (i.plan_id === plan.id ? i.seq : null)),
      sealed_t_us: tUs(BigInt(b.sealed_ns)),
      sent_t_us: tUs(BigInt(b.sent_ns)),
      tree_size_before: b.tree_size_before,
      tree_size_after: b.sth.tree_size,
      root_hash: b.sth.root_hash,
      sth: b.sth,
      sth_signature: b.sth_signature,
      authority_ms,
      delayed: b.delayed,
    });
    if (authorityFailing) {
      authorityFailing = false;
      emit("failure", { step: null, span_id: null, kind: "authority_down", attempt: 0, recovered: true });
    }
    const batch_leaf_indexes = mine.map((i) => i.proof.leaf_index ?? 0);
    for (const it of mine) {
      const m = meta.get(it.receipt_id);
      if (!m) continue;
      const anchored = { ...m.receipt, log_inclusion_proof: it.proof };
      const v = verifyAerfReceipt(anchored, { issuerPublicKey: issuerPub, logPublicKey: logPub, requireLog: true });
      held[m.seq - 1] = anchored;
      const prefix = held.slice(0, m.seq);
      const chain_ok = prefix.every(Boolean) && verifyAerfChain(prefix, { issuerPublicKey: issuerPub }).valid;
      const anchor_ms = r1(Number(BigInt(b.done_ns) - m.signedNs) / 1e6);
      stats.anchor.push(anchor_ms);
      const leaf_index = it.proof.leaf_index ?? 0;
      emit("anchored", {
        step: m.step,
        seq: m.seq,
        receipt_id: it.receipt_id,
        batch_id: b.batch_id,
        batch_size: b.leaf_hashes.length,
        leaf_index,
        tree_size: it.proof.tree_size,
        tree_size_before: b.tree_size_before,
        root_hash: b.sth.root_hash,
        sth_signature: b.sth_signature,
        anchor_ms,
        batch_leaf_indexes,
        audit_path: auditPathSides(leaf_index, it.proof.tree_size, it.proof.audit_path),
        delayed: b.delayed,
        clock_skew_ms: Date.parse(b.sth.timestamp) - Date.parse(String(m.receipt.observed_at)),
      });
      emit("verified", {
        step: m.step,
        seq: m.seq,
        receipt_id: it.receipt_id,
        issuer: v.issuerOk,
        log: v.log === "passed" ? "passed" : "failed",
        chain_ok,
        ...(v.ok ? {} : { reason: v.failReason }),
      });
      pending.delete(it.receipt_id);
    }
    if (pending.size === 0) wake?.();
  };
  const onConsistency = (c: { batch_id: number; from_size: number; to_size: number; ok: boolean; plans: string[] }) => {
    if (c.plans.includes(plan.id)) emit("consistency", { batch_id: c.batch_id, from_size: c.from_size, to_size: c.to_size, ok: c.ok });
  };
  const onAnchorFailure = (f: { attempt: number; error: string; plans: string[] }) => {
    if (!f.plans.includes(plan.id)) return;
    authorityFailing = true;
    emit("failure", { step: null, span_id: null, kind: "authority_down", attempt: f.attempt, recovered: false, reason: f.error });
  };
  let downStep: number | null = null;
  const onDown = () => {
    downStep = currentStep;
    emit("failure", { step: downStep, span_id: null, kind: "signer_crash", attempt: 1, recovered: false });
  };
  const onUp = (u: { downtime_ms: number }) => {
    emit("failure", { step: downStep, span_id: null, kind: "signer_crash", attempt: 1, recovered: true, downtime_ms: u.downtime_ms });
    void track(issue("error:signer_crash", { error: { kind: "signer_crash", attempt: 1, downtime_ms: u.downtime_ms, recovered: true } }, downStep));
  };
  signer.on("batch", onBatch);
  signer.on("consistency", onConsistency);
  signer.on("anchor_failure", onAnchorFailure);
  signer.on("down", onDown);
  signer.on("up", onUp);

  // ── Trace hooks: every model / tool / downstream event comes from the wrappers ──
  const hooks: CallHooks = {
    sign: signStep,
    onSpan: (s) =>
      emit("span", {
        step: s.step,
        span_id: s.span_id,
        parent_id: s.parent_id,
        kind: s.kind,
        name: s.name,
        start_us: s.start_us,
        dur_us: s.dur_us,
        attrs: s.attrs,
        attrs_sha256: s.attrs_sha256,
        status: s.status,
        attempt: s.attempt,
        ...(s.error_kind ? { error_kind: s.error_kind } : {}),
      }),
    onLlmRequest: (req, step) => {
      const r = req as { system?: string; metadata?: { prompt_version?: string; rules?: string[] }; messages?: unknown[] };
      emit("model_input", {
        step,
        at: currentAt,
        prompt_version: r.metadata?.prompt_version ?? PROMPT_VERSION,
        prompt_sha256: sha256Hex(Buffer.from(r.system ?? "", "utf8")),
        prompt_preview: r.system ?? "",
        rules_in_context: r.metadata?.rules ?? [],
        transcript_turns: r.messages?.length ?? 0,
      });
    },
    onToolCall: (name, input, step) => emit("tool_call", { step, name, input }),
    onToolResult: (name, result, step) => emit("tool_result", { step, name, result }),
    onDecision: (record, step, claims) => emit("decision", { step, decision_record: record, claims, rule_text: RULES[String(record.rule_id)] }),
    onFailure: (f) => {
      if (f.step === null) return;
      const list = stepFailures.get(f.step) ?? [];
      list.push(f);
      stepFailures.set(f.step, list);
    },
    claims: (_thinking, step) => (step === null ? [] : (STEPS[step]?.claims ?? [])),
  };

  let reconciliation: Reconciliation = { provider_requests: 0, matched: 0, unmatched: [] };
  try {
    await traceCall(
      hooks,
      async (call) => {
        emit("start", {
          rules: RULES,
          prompt_version: PROMPT_VERSION,
          issuer_key_id: signer.keyId,
          log_id: o.logId,
          plan_id: plan.id,
          trace_id: call.trace_id,
          failures: [...failures],
        });
        if (failures.has("authority_down")) await signer.failAuthority(o.authorityDownMs ?? 2000);
        const faults: Faults = {};
        const { agent, provider } = buildAgent({
          wait: sleep,
          onGenerate: (chunk) => emit("thinking", { step: currentStep, chunk }),
          faults,
        });
        await o.onProvider?.(provider, provider.client);

        const history: Turn[] = [];
        let stepNo = 0;
        for (const line of SCRIPT) {
          if (o.aborted?.()) throw new Error("call abandoned");
          if (line.who === "caller" || !line.step) {
            const text = line.text ?? "";
            history.push({ who: line.who, at: line.at, text });
            emit("turn", { who: line.who, at: line.at, text });
            await sleep(900);
            continue;
          }
          const step = stepNo++;
          currentStep = step;
          currentAt = line.at;
          if (step === 1 && failures.has("llm_timeout")) provider.failNext = "timeout";
          if (step === 2 && failures.has("tool_error")) faults.toolErrorOnce = line.step.tool.name;
          let say: string;
          try {
            say = await traceTurn({ step, at: line.at }, () => agent.respond(history));
          } catch (err) {
            for (const f of stepFailures.get(step) ?? []) emit("failure", { ...f, recovered: false });
            emit("error", { step, message: err instanceof Error ? err.message : String(err) });
            break;
          }
          for (const f of stepFailures.get(step) ?? []) emit("failure", { ...f, recovered: true });
          await sleep(300);
          history.push({ who: "agent", at: line.at, text: say });
          emit("turn", { who: "agent", at: line.at, text: say });
          await sleep(900);
        }
        currentStep = null;

        // Completeness: the close receipt commits to what happened in the call.
        await Promise.all([...issuing]);
        await track(
          issue(
            "close:call",
            { counts: { ...call.counts, receipts: held.length }, llm_request_ids: call.requestIds, trace_id: call.trace_id },
            null,
          ),
        );
        reconciliation = reconcile(provider.log, held);
      },
      t0,
    );
  } catch (err) {
    emit("error", { message: err instanceof Error ? err.message : String(err) });
  }

  // Wait (off the hot path) for every receipt to be anchored and verified.
  if (pending.size > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, o.anchorTimeoutMs ?? 60_000);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  signer.off("batch", onBatch);
  signer.off("consistency", onConsistency);
  signer.off("anchor_failure", onAnchorFailure);
  signer.off("down", onDown);
  signer.off("up", onUp);
  void signer.closePlan(plan.id).catch(() => undefined);
  if (pending.size > 0) emit("error", { message: `${pending.size} receipt(s) not anchored before timeout` });

  emit("reconciled", { ...reconciliation });
  const receipts = held.filter(Boolean);
  const chain = verifyAerfChain(receipts, { issuerPublicKey: issuerPub });
  const integrity = checkIntegrity(receipts, (r) => aerfChainHash(r));
  const consistency = await callConsistency(o.authorityUrl, sths);
  const done = {
    chain: { valid: chain.valid, length: chain.length, rootHash: chain.rootHash },
    receipts: receipts.length,
    anchored: receipts.filter((r) => r.log_inclusion_proof).length,
    batches: batchIds.size,
    sign_us_p50: pct(stats.sign).p50,
    sign_us_max: pct(stats.sign).max,
    anchor_ms_p50: pct(stats.anchor).p50,
    anchor_ms_max: pct(stats.anchor).max,
    latency: {
      hot_path_us: pct(stats.hot),
      sign_us: pct(stats.sign),
      ipc_rtt_us: pct(stats.rtt),
      anchor_ms: pct(stats.anchor),
    },
    consistency,
    integrity,
    reconciled: reconciliation,
  };
  emit("done", done);
  return { plan_id: plan.id, receipts, integrity, reconciliation, done };
}

/** Verify the log grew append-only between the first and last tree head this call saw. */
async function callConsistency(authorityUrl: string, sths: Sth[]): Promise<Record<string, unknown>> {
  if (sths.length === 0) return { from_size: 0, to_size: 0, ok: false, reason: "no tree heads" };
  const first = sths.reduce((a, b) => (b.tree_size < a.tree_size ? b : a));
  const last = sths.reduce((a, b) => (b.tree_size > a.tree_size ? b : a));
  if (first.tree_size === last.tree_size) {
    return { from_size: first.tree_size, to_size: last.tree_size, ok: first.root_hash === last.root_hash, proof_len: 0 };
  }
  try {
    const res = await fetch(`${authorityBase(authorityUrl)}/v1/consistency?from=${first.tree_size}&to=${last.tree_size}`);
    const body = (await res.json()) as { proof?: string[] };
    const proof = body.proof ?? [];
    return {
      from_size: first.tree_size,
      to_size: last.tree_size,
      ok: res.ok && verifyConsistency(first.tree_size, last.tree_size, first.root_hash, last.root_hash, proof),
      proof_len: proof.length,
    };
  } catch (err) {
    return { from_size: first.tree_size, to_size: last.tree_size, ok: false, reason: String(err) };
  }
}
