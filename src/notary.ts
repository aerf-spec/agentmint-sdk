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

  constructor(opts: NotaryOptions = {}) {
    this.stateDir = opts.stateDir;
    this.mode = opts.mode ?? "enforce";
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
    const { plan } = input;
    const chain = this.chains.get(plan.id) ?? { seq: 0 };

    const evaluation = evaluatePolicy(input.action, input.agent, plan);

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
    const trajectoryEntry: SessionTrajectoryEntry = {
      action: input.action,
      agent: input.agent,
      in_policy: inPolicy,
      observed_at: observedAt,
    };
    this.trajectory.push(trajectoryEntry);
    const recent = this.trajectory.slice(-TRAJECTORY_WINDOW);

    const policyHash = computePolicyHash(plan);
    const contextHash = input.context !== undefined ? contextHashSha256(input.context) : undefined;

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
        planId: plan.id,
        agent: input.agent,
        action: input.action,
        inPolicy,
        policyReason: reason,
        evidence: input.evidence,
        observedAt,
        previousReceiptHash: chain.previousHash,
        seq: chain.seq + 1,
        planSignature: plan.signature,
        policyHash,
        outputHash: input.output ? sha256Hex(canonicalBytes(input.output)) : undefined,
        reasoningHash:
          input.reasoning !== undefined
            ? sha256Hex(Buffer.from(input.reasoning, "utf-8"))
            : undefined,
        sessionId: this.sessionId,
        sessionTrajectory: recent,
        mode: this.mode,
        originalVerdict,
        impactTags: input.impactTags,
        contextHashSha256: contextHash,
        pdpSignature,
        pdpKeyId: pdpSignature ? pdpKeyId : undefined,
      },
      { issuerPrivateKey: this.key, agentPrivateKey: input.agentPrivateKey },
    );

    // Advance and persist the chain BEFORE emitting to sinks.
    chain.previousHash = aerfChainHash(receipt as unknown as Record<string, unknown>);
    chain.seq += 1;
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
        const s = state as { previousHash?: unknown; seq?: unknown };
        this.chains.set(planId, {
          previousHash: typeof s.previousHash === "string" ? s.previousHash : undefined,
          seq: typeof s.seq === "number" && Number.isSafeInteger(s.seq) ? s.seq : 0,
        });
      }
    } catch {
      // Corrupt state file: start fresh rather than refuse to run.
    }
  }

  private saveChainState(): void {
    if (!this.stateDir) return;
    mkdirSync(this.stateDir, { recursive: true });
    const out: Record<string, { previousHash?: string; seq: number }> = {};
    for (const [planId, state] of this.chains) {
      out[planId] = { ...(state.previousHash ? { previousHash: state.previousHash } : {}), seq: state.seq };
    }
    atomicWrite(join(this.stateDir, CHAIN_STATE_FILE), JSON.stringify(out, null, 2), 0o600);
  }
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
