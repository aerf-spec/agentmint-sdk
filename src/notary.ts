// Notary — observe, evaluate, sign, chain (port of agentmint.notary.Notary).
//
// Holds the issuer key and per-plan chain state (previous hash + monotonic
// seq, isolated per plan_id). With a stateDir, keys and chain state persist
// across process restarts via atomic writes, so a chain continues where it
// left off instead of forking a second genesis.
import {
  randomUUID,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { canonicalBytes, sha256Hex } from "./kernel/canonical.js";
import {
  generateKeyPair,
  privateKeyFromPem,
  privateKeyToPem,
  publicKeyToPem,
  keyId,
} from "./kernel/sign.js";
import {
  buildAerfReceipt,
  aerfChainHash,
  contextHashSha256,
  signPdpTuple,
  isoNowUtc,
  AerfReceiptError,
  type AerfReceipt,
  type AerfMode,
  type SessionTrajectoryEntry,
} from "./receipt-aerf.js";
import {
  signPlan,
  verifyPlan,
  evaluatePolicy,
  computePolicyHash,
  isPlanExpired,
  delegatePlan,
  type PlanReceipt,
  type PlanInit,
} from "./plan.js";
import { verifyAerfChain, type ChainVerification } from "./chain.js";
import { verifyStripped } from "./kernel/sign.js";
import {
  SALTED_COMMITMENT_ALG,
  newSalt,
  saltedCommitment,
  saltedContextCommitment,
  type CommitmentMode,
  type Disclosure,
  type DisclosureSink,
} from "./commitments.js";
import {
  collectTraceLinks,
  formatTraceparent,
  type TraceContext,
  type TraceLinkPlugin,
} from "./trace-links.js";

const CHAIN_STATE_FILE = "chain_state.json";
const KEY_FILE = "notary_key.pem";
const TRAJECTORY_WINDOW = 5;

/** Anything that accepts issued receipts (files, OTel, test capture, …). */
export interface ReceiptSink {
  emit(receipt: AerfReceipt): void;
}

interface ChainState {
  /** §8.4 chain hash of the last receipt, or undefined before genesis. */
  previousHash?: string;
  /** Last seq issued (0 before genesis). */
  seq: number;
  /** Set once a close receipt has been issued; the chain accepts no more receipts. */
  closed?: boolean;
}

/** Action name of the final receipt issued by {@link Notary.close}. */
export const CLOSE_ACTION = "close";
/** `evidence.type` of a close receipt. */
export const CLOSE_EVIDENCE_TYPE = "chain_close";

export interface CloseOptions {
  agent: string;
  /** Non-negative integer tallies for the run, e.g. { actions: 12, blocked: 1 }. */
  counts: Record<string, number>;
}

export interface NotaryOptions {
  /** Issuer private key (PKCS8 PEM). Ephemeral key generated when omitted. */
  privateKeyPem?: string;
  /**
   * Directory for persistent state: the issuer key (created on first use,
   * mode 0600) and per-plan chain state. Omit for fully ephemeral operation.
   */
  stateDir?: string;
  /** Receipt sink(s); failures in one sink never block issuance or others. */
  sink?: ReceiptSink | ReceiptSink[];
  /** Enforcement mode recorded on receipts. Default "enforce". */
  mode?: AerfMode;
  /**
   * How reasoning and context are committed. "plain" (default): SHA-256 of
   * the value. "salted": SHA-256 over a fresh per-field 32-byte salt, the
   * receipt carries `commitment_alg: "sha256-salted-v1"`, and the salts are
   * available only via {@link Notary.disclosure} / `disclosureSink`.
   */
  commitments?: CommitmentMode;
  /** Receives each receipt's Disclosure in salted mode. Failures never block issuance. */
  disclosureSink?: DisclosureSink;
  /** Plugins that turn a receipt's trace context into evidence links. */
  traceLinks?: TraceLinkPlugin[];
}

export interface NotariseInput {
  action: string;
  agent: string;
  plan: PlanReceipt;
  evidence: Record<string, unknown>;
  /** Acting agent's own key — adds agent_signature over canonical(evidence). */
  agentPrivateKey?: string | KeyObject;
  /** Action output; hashed (SHA-256 of canonical) into output_hash. */
  output?: Record<string, unknown>;
  /** Reasoning text; hashed (SHA-256, utf-8) into reasoning_hash. */
  reasoning?: string;
  /** HIGH-IMPACT tags (SPEC §17). Non-empty requires PDP + parent keys at verify time. */
  impactTags?: readonly string[];
  /** Input context the agent observed; hashed into context_hash_sha256. */
  context?: unknown;
  /** Independently-keyed Policy Decision Point key: signs the §17 tuple. */
  pdpPrivateKey?: string | KeyObject;
  /**
   * W3C trace context. Adds `traceparent` (and `links` from configured
   * trace-link plugins) to the signed evidence.
   */
  trace?: TraceContext;
}

export class Notary {
  private readonly key: KeyObject;
  private readonly publicKey: KeyObject;
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly sessionId: string;
  private readonly stateDir?: string;
  private readonly mode: AerfMode;
  private readonly sinks: ReceiptSink[];
  private readonly chains = new Map<string, ChainState>();
  private readonly receiptsByPlan = new Map<string, AerfReceipt[]>();
  private readonly plans = new Map<string, PlanReceipt>();
  private readonly childPlans = new Map<string, string[]>();
  private readonly trajectory: SessionTrajectoryEntry[] = [];
  private readonly commitments: CommitmentMode;
  private readonly disclosureSink?: DisclosureSink;
  private readonly traceLinks: TraceLinkPlugin[];
  private readonly disclosures = new Map<string, Disclosure>();

  constructor(opts: NotaryOptions = {}) {
    this.stateDir = opts.stateDir;
    this.mode = opts.mode ?? "enforce";
    this.commitments = opts.commitments ?? "plain";
    if (this.commitments !== "plain" && this.commitments !== "salted") {
      throw new AerfReceiptError(`commitments must be "plain" or "salted", got ${String(opts.commitments)}`);
    }
    this.disclosureSink = opts.disclosureSink;
    this.traceLinks = [...(opts.traceLinks ?? [])];
    this.sinks = opts.sink === undefined ? [] : Array.isArray(opts.sink) ? opts.sink : [opts.sink];
    this.key = this.loadOrCreateKey(opts.privateKeyPem);
    this.publicKey = createPublicKey(this.key);
    this.keyId = keyId(this.publicKey);
    this.publicKeyPem = publicKeyToPem(this.publicKey);
    this.sessionId = randomUUID();
    this.loadChainState();
  }

  /** Create a signed plan and initialize its (empty) chain. */
  createPlan(init: PlanInit): PlanReceipt {
    const plan = signPlan(init, this.key);
    this.plans.set(plan.id, plan);
    if (!this.chains.has(plan.id)) {
      this.chains.set(plan.id, { seq: 0 });
      this.saveChainState();
    }
    return plan;
  }

  /**
   * Observe an action and issue a signed, chained evidence receipt. Chain
   * state is isolated per plan: receipts for plan A never link to plan B.
   */
  notarise(input: NotariseInput): AerfReceipt {
    return this.issue(input);
  }

  /**
   * Issue the final receipt of a plan's chain: `action: "close"`, evidence
   * `{ type: "chain_close", counts, receipts_before_close }`. Its signed seq
   * equals the chain length, so {@link verifyClose} detects a dropped tail.
   * The plan accepts no further receipts afterwards.
   */
  close(plan: PlanReceipt, opts: CloseOptions): AerfReceipt {
    const counts = requireCounts(opts.counts);
    const chain = this.chains.get(plan.id) ?? { seq: 0 };
    return this.issue(
      {
        action: CLOSE_ACTION,
        agent: opts.agent,
        plan,
        evidence: { type: CLOSE_EVIDENCE_TYPE, counts, receipts_before_close: chain.seq },
      },
      { inPolicy: true, reason: "chain close" },
    );
  }

  /**
   * The salt openings for a receipt issued in salted mode, or undefined (plain
   * mode, unknown id, or nothing committed). Held in memory for this Notary.
   */
  disclosure(receiptId: string): Disclosure | undefined {
    const d = this.disclosures.get(receiptId);
    return d && structuredClone(d);
  }

  private issue(input: NotariseInput, closeVerdict?: { inPolicy: boolean; reason: string }): AerfReceipt {
    const { plan } = input;
    const chain = this.chains.get(plan.id) ?? { seq: 0 };
    if (chain.closed) {
      throw new AerfReceiptError(`plan ${plan.id} is closed — no receipts may follow a close receipt`);
    }

    const evaluation = closeVerdict ?? evaluatePolicy(input.action, input.agent, plan);

    // Shadow/warn modes evaluate fully but never claim a block happened.
    let inPolicy = evaluation.inPolicy;
    let reason = evaluation.reason;
    let originalVerdict: boolean | undefined;
    if (this.mode !== "enforce") {
      originalVerdict = inPolicy;
      inPolicy = true;
      if (!originalVerdict) reason = `${this.mode}:${reason}`;
    }

    const observedAt = isoNowUtc();
    // Trace context is validated before any state changes.
    let evidence = input.evidence;
    if (input.trace !== undefined) {
      const traceparent = formatTraceparent(input.trace);
      const links = collectTraceLinks(this.traceLinks, {
        trace_id: input.trace.trace_id,
        span_id: input.trace.span_id,
        ...(input.trace.request_id !== undefined ? { request_id: input.trace.request_id } : {}),
        started_at: observedAt,
      });
      if (evidence && typeof evidence === "object" && ("traceparent" in evidence || (links.length > 0 && "links" in evidence))) {
        throw new AerfReceiptError("evidence already has 'traceparent'/'links' — omit them when passing trace");
      }
      evidence = { ...evidence, traceparent, ...(links.length > 0 ? { links } : {}) };
    }

    const trajectoryEntry: SessionTrajectoryEntry = {
      action: input.action,
      agent: input.agent,
      in_policy: inPolicy,
      observed_at: observedAt,
    };
    this.trajectory.push(trajectoryEntry);
    const recent = this.trajectory.slice(-TRAJECTORY_WINDOW);

    const policyHash = computePolicyHash(plan);
    const salted = this.commitments === "salted";
    const receiptId = randomUUID();
    const disclosure: Disclosure = { receipt_id: receiptId };

    let contextHash: string | undefined;
    if (input.context !== undefined) {
      if (salted) {
        const salt = newSalt();
        const { hash, canonical } = saltedContextCommitment(salt, input.context);
        contextHash = hash;
        disclosure.context = { salt, canonical };
      } else {
        contextHash = contextHashSha256(input.context);
      }
    }
    let reasoningHash: string | undefined;
    if (input.reasoning !== undefined) {
      if (salted) {
        const salt = newSalt();
        reasoningHash = saltedCommitment(salt, input.reasoning);
        disclosure.reasoning = { salt, text: input.reasoning };
      } else {
        reasoningHash = sha256Hex(Buffer.from(input.reasoning, "utf-8"));
      }
    }
    const hasDisclosure = disclosure.context !== undefined || disclosure.reasoning !== undefined;


    if (input.impactTags && input.impactTags.length > 0) {
      if (!input.pdpPrivateKey || input.context === undefined) {
        throw new AerfReceiptError(
          "impact_tags require a PDP signature over {context_hash_sha256, in_policy, policy_hash} " +
            "— pass pdpPrivateKey and context (SPEC §3/§17)",
        );
      }
    }
    const pdpSignature =
      input.pdpPrivateKey && contextHash !== undefined
        ? signPdpTuple(contextHash, inPolicy, policyHash, input.pdpPrivateKey)
        : undefined;
    const pdpKeyId = input.pdpPrivateKey
      ? keyId(
          createPublicKey(
            typeof input.pdpPrivateKey === "string"
              ? privateKeyFromPem(input.pdpPrivateKey)
              : input.pdpPrivateKey,
          ),
        )
      : undefined;

    const receipt = buildAerfReceipt(
      {
        id: receiptId,
        planId: plan.id,
        agent: input.agent,
        action: input.action,
        inPolicy,
        policyReason: reason,
        evidence,
        observedAt,
        previousReceiptHash: chain.previousHash,
        seq: chain.seq + 1,
        planSignature: plan.signature,
        policyHash,
        outputHash: input.output ? sha256Hex(canonicalBytes(input.output)) : undefined,
        reasoningHash,
        sessionId: this.sessionId,
        sessionTrajectory: recent,
        mode: this.mode,
        originalVerdict,
        impactTags: input.impactTags,
        contextHashSha256: contextHash,
        pdpSignature,
        pdpKeyId: pdpSignature ? pdpKeyId : undefined,
        commitmentAlg: salted && hasDisclosure ? SALTED_COMMITMENT_ALG : undefined,
      },
      { issuerPrivateKey: this.key, agentPrivateKey: input.agentPrivateKey },
    );

    // Advance and persist the chain BEFORE emitting to sinks.
    chain.previousHash = aerfChainHash(receipt as unknown as Record<string, unknown>);
    chain.seq += 1;
    if (closeVerdict) chain.closed = true;
    this.chains.set(plan.id, chain);
    this.saveChainState();

    const list = this.receiptsByPlan.get(plan.id) ?? [];
    list.push(receipt);
    this.receiptsByPlan.set(plan.id, list);

    for (const sink of this.sinks) {
      try {
        sink.emit(receipt);
      } catch {
        // One sink's failure never blocks issuance or the other sinks.
      }
    }
    if (salted && hasDisclosure) {
      this.disclosures.set(receiptId, disclosure);
      try {
        this.disclosureSink?.emit(structuredClone(disclosure));
      } catch {
        // A disclosure sink failure never blocks issuance.
      }
    }
    return receipt;
  }

  /** All receipts issued for a plan this session, in order. */
  receipts(planId: string): AerfReceipt[] {
    return [...(this.receiptsByPlan.get(planId) ?? [])];
  }

  /** The plan issued under this notary for the id, if any. */
  plan(planId: string): PlanReceipt | undefined {
    return this.plans.get(planId);
  }

  verifyReceipt(receipt: AerfReceipt): boolean {
    return verifyStripped(
      receipt as unknown as Record<string, unknown>,
      this.publicKey,
      receipt.signature,
    );
  }

  verifyPlan(plan: PlanReceipt): boolean {
    return verifyPlan(plan, this.publicKey);
  }

  /** Verify the full chain for a plan (signatures + hash links + seq). */
  verifyChain(planId: string): ChainVerification {
    return verifyAerfChain(
      this.receipts(planId) as unknown as Record<string, unknown>[],
      { issuerPublicKey: this.publicKey },
    );
  }

  /** Create a child plan with scope intersected from the parent's. */
  delegateToAgent(
    parent: PlanReceipt,
    init: { childAgent: string; requestedScope: readonly string[]; action?: string; ttlSeconds?: number },
  ): PlanReceipt {
    if (isPlanExpired(parent)) throw new AerfReceiptError("cannot delegate from an expired plan");
    const child = delegatePlan(parent, init, this.key);
    this.plans.set(child.id, child);
    this.chains.set(child.id, { seq: 0 });
    this.saveChainState();
    const children = this.childPlans.get(parent.id) ?? [];
    children.push(child.id);
    this.childPlans.set(parent.id, children);
    return child;
  }

  /**
   * Export every receipt issued for a plan as a portable evidence zip. The
   * archive verifies standalone: `unzip && node verify.mjs`.
   */
  async exportEvidence(planId: string, outPath: string): Promise<string> {
    const plan = this.plans.get(planId);
    if (!plan) throw new AerfReceiptError(`no plan ${planId} — call createPlan() first`);
    const { EvidencePackage } = await import("./evidence.js");
    const pkg = new EvidencePackage({
      plan,
      publicKeyPem: this.publicKeyPem,
      signingKey: this.key,
    });
    for (const r of this.receipts(planId)) pkg.add(r);
    return pkg.export(outPath);
  }

  /** The delegation tree rooted at a plan id. */
  auditTree(planId: string): { plan_id: string; children: unknown[] } {
    return {
      plan_id: planId,
      children: (this.childPlans.get(planId) ?? []).map((cid) => this.auditTree(cid)),
    };
  }

  // ── Persistence ───────────────────────────────────────────────────

  private loadOrCreateKey(privateKeyPem?: string): KeyObject {
    if (privateKeyPem) return privateKeyFromPem(privateKeyPem);
    if (this.stateDir) {
      const keyPath = join(this.stateDir, KEY_FILE);
      if (existsSync(keyPath)) return privateKeyFromPem(readFileSync(keyPath, "utf-8"));
      const { privateKey } = generateKeyPair();
      mkdirSync(this.stateDir, { recursive: true });
      atomicWrite(keyPath, privateKeyToPem(privateKey), 0o600);
      return privateKey;
    }
    return generateKeyPair().privateKey;
  }

  private loadChainState(): void {
    if (!this.stateDir) return;
    const path = join(this.stateDir, CHAIN_STATE_FILE);
    if (!existsSync(path)) return;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      if (typeof data !== "object" || data === null) return;
      for (const [planId, state] of Object.entries(data as Record<string, unknown>)) {
        if (typeof state !== "object" || state === null) continue;
        const s = state as { previousHash?: unknown; seq?: unknown; closed?: unknown };
        this.chains.set(planId, {
          previousHash: typeof s.previousHash === "string" ? s.previousHash : undefined,
          seq: typeof s.seq === "number" && Number.isSafeInteger(s.seq) ? s.seq : 0,
          ...(s.closed === true ? { closed: true } : {}),
        });
      }
    } catch {
      // Corrupt state file: start fresh rather than refuse to run.
    }
  }

  private saveChainState(): void {
    if (!this.stateDir) return;
    mkdirSync(this.stateDir, { recursive: true });
    const out: Record<string, { previousHash?: string; seq: number; closed?: boolean }> = {};
    for (const [planId, state] of this.chains) {
      out[planId] = {
        ...(state.previousHash ? { previousHash: state.previousHash } : {}),
        seq: state.seq,
        ...(state.closed ? { closed: true } : {}),
      };
    }
    atomicWrite(join(this.stateDir, CHAIN_STATE_FILE), JSON.stringify(out, null, 2), 0o600);
  }
}

function requireCounts(counts: unknown): Record<string, number> {
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) {
    throw new AerfReceiptError("close counts must be an object of non-negative integers");
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
      throw new AerfReceiptError(`close count '${k}' must be a non-negative integer, got ${String(v)}`);
    }
    out[k] = v;
  }
  return out;
}

export interface CloseVerification {
  ok: boolean;
  /** Counts recorded on the close receipt, when one was found. */
  counts?: Record<string, number>;
  reason?: string;
  /** Underlying chain verification (signatures when a key is given, links, seq). */
  chain: ChainVerification;
}

/**
 * Verify a plan's chain ends in a close receipt: the chain itself verifies
 * (signatures too when `issuerPublicKey` is given), the LAST receipt is the
 * only close receipt, and its signed `seq` equals the number of receipts. A
 * dropped tail — or a chain that was never closed — fails.
 */
export function verifyClose(
  receipts: readonly Record<string, unknown>[] | readonly AerfReceipt[],
  opts: { issuerPublicKey?: string | KeyObject } = {},
): CloseVerification {
  const list = receipts as readonly Record<string, unknown>[];
  const chain = verifyAerfChain(list, opts);
  const fail = (reason: string): CloseVerification => ({ ok: false, reason, chain });
  if (!chain.valid) return fail(`chain invalid: ${chain.reason ?? chain.breakType}`);
  if (list.length === 0) return fail("no receipts — chain was never closed");
  const isClose = (r: Record<string, unknown>): boolean => {
    const ev = r["evidence"];
    return (
      r["action"] === CLOSE_ACTION &&
      typeof ev === "object" && ev !== null &&
      (ev as Record<string, unknown>)["type"] === CLOSE_EVIDENCE_TYPE
    );
  };
  const last = list[list.length - 1]!;
  if (!isClose(last)) return fail("last receipt is not a close receipt — chain unclosed or its tail was dropped");
  const earlier = list.slice(0, -1).findIndex(isClose);
  if (earlier !== -1) return fail(`receipt [${earlier}] is a close receipt but is not last`);
  if (last["seq"] !== list.length) {
    return fail(`close receipt seq ${String(last["seq"])} != chain length ${list.length}`);
  }
  const ev = last["evidence"] as Record<string, unknown>;
  if (ev["receipts_before_close"] !== undefined && ev["receipts_before_close"] !== list.length - 1) {
    return fail(`close receipt counts ${String(ev["receipts_before_close"])} prior receipts, chain has ${list.length - 1}`);
  }
  const counts = ev["counts"];
  if (typeof counts !== "object" || counts === null || Array.isArray(counts) ||
      !Object.values(counts).every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) {
    return fail("close receipt counts are not non-negative integers");
  }
  return { ok: true, counts: { ...(counts as Record<string, number>) }, chain };
}

function atomicWrite(path: string, content: string, mode: number): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/** Append-only JSONL file sink: one line per receipt, grouped per plan. */
export class FileReceiptSink implements ReceiptSink {
  constructor(private readonly dir: string) {}
  emit(receipt: AerfReceipt): void {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, `${receipt.plan_id}.jsonl`);
    writeFileSync(path, JSON.stringify(receipt) + "\n", { flag: "a" });
  }
}
