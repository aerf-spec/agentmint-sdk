// Agent-side client for the signer process. The agent never holds the issuer
// key: it sends unsigned payloads over a unix domain socket (length-prefixed
// JSON frames, pipelined by request id) and gets signed receipts back.
//
// Supervision: if the signer dies, the client respawns it, reconnects, and
// re-sends every unanswered request. Signs carry an idempotency key, so a
// request the signer had already written to its WAL returns the same receipt;
// one it never saw is signed now, continuing the chain with no gap. Callers
// simply wait (checkpoint semantics) while the signer is down.
import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { frameReader, writeFrame } from "./frames.js";
import type { PlanInit, PlanReceipt } from "../src/plan.js";
import type { LogInclusionProof } from "../src/receipt-aerf.js";
import type { Sth } from "./authority.js";

const here = dirname(fileURLToPath(import.meta.url));
const PASS_ENV = [
  "PATH", "HOME", "SIGNER_SPIN", "SIGNER_KEEPWARM_MS", "TMPDIR", "NODE_ENV", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy",
];

export interface SignerOptions {
  authorityUrl: string;
  stateDir: string;
  issuerPrivateKeyPem?: string;
  flushMs?: number;
  maxBatch?: number;
}

export interface SignInput {
  plan_id: string;
  action: string;
  agent: string;
  evidence: Record<string, unknown>;
  reasoning_hash?: string;
  context_hash?: string;
  commitment_alg?: string;
}

export interface SignResult {
  receipt: Record<string, unknown>;
  chain_hash: string;
  leaf_hash: string;
  /** Time inside the signer (build + canonicalize + Ed25519 + WAL append). */
  sign_us: number;
  /** Round trip as seen by the agent, including IPC framing. */
  rtt_us: number;
  queue_depth: number;
  replay?: boolean;
}

export interface BatchItem {
  leaf: string;
  receipt_id: string;
  plan_id: string;
  seq: number;
  queued_ns: string;
  proof: LogInclusionProof;
}

export interface BatchEvent {
  batch_id: number;
  leaf_hashes: string[];
  items: BatchItem[];
  sealed_ns: string;
  sent_ns: string;
  done_ns: string;
  tree_size_before: number;
  sth: Sth;
  sth_signature: string;
  delayed: boolean;
}

interface Pending {
  msg: Record<string, unknown>;
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  t0: bigint;
}

export class SignerClient extends EventEmitter {
  keyId = "";
  publicKeyPem = "";
  private child?: ChildProcess;
  private sock?: Socket;
  private readonly socketPath = join(tmpdir(), `agentmint-signer-${process.pid}-${randomBytes(4).toString("hex")}.sock`);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private up = false;
  private stopped = false;
  private restarts = 0;
  private downSince = 0n;
  private restarting = false;

  private constructor(private readonly opts: SignerOptions) {
    super();
  }

  static async start(opts: SignerOptions): Promise<SignerClient> {
    const c = new SignerClient(opts);
    await c.boot();
    return c;
  }

  private spawnChild(): void {
    // Minimal environment: runtime + network (proxy / CA) settings only.
    const env: NodeJS.ProcessEnv = {};
    for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
    Object.assign(env, {
      SIGNER_SOCKET: this.socketPath,
      SIGNER_STATE_DIR: this.opts.stateDir,
      AUTHORITY_URL: this.opts.authorityUrl,
      ANCHOR_FLUSH_MS: String(this.opts.flushMs ?? 250),
      ANCHOR_MAX_BATCH: String(this.opts.maxBatch ?? 64),
    });
    if (this.opts.issuerPrivateKeyPem) env.ISSUER_PRIVATE_KEY_PEM = this.opts.issuerPrivateKeyPem;
    const child = spawn(process.execPath, ["--import", "tsx", join(here, "signer-proc.ts")], {
      env,
      stdio: ["pipe", "inherit", "inherit"],
      cwd: join(here, ".."),
    });
    child.on("exit", () => {
      if (this.child === child) this.onDown();
    });
    this.child = child;
  }

  private async boot(): Promise<void> {
    this.spawnChild();
    await this.connectWithRetry();
    const hello = await this.request({ op: "hello" });
    this.keyId = hello.key_id as string;
    this.publicKeyPem = hello.public_key_pem as string;
  }

  private connectWithRetry(deadlineMs = 15_000): Promise<void> {
    const until = Date.now() + deadlineMs;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const sock = connect(this.socketPath);
        sock.once("connect", () => {
          sock.removeAllListeners("error");
          this.attach(sock);
          resolve();
        });
        sock.once("error", () => {
          sock.destroy();
          if (this.stopped) return reject(new Error("signer stopped"));
          if (Date.now() > until) return reject(new Error("signer did not come up"));
          setTimeout(attempt, 25);
        });
      };
      attempt();
    });
  }

  private attach(sock: Socket): void {
    this.sock = sock;
    this.up = true;
    sock.on("data", frameReader((m) => this.onFrame(m as Record<string, unknown>)));
    sock.on("error", () => undefined);
    sock.on("close", () => {
      if (this.sock === sock) this.onDown();
    });
    // Re-send everything unanswered, in order (pipelined; signs are idempotent).
    for (const [id, p] of [...this.pending].sort((a, b) => a[0] - b[0])) writeFrame(sock, { ...p.msg, id });
  }

  private onDown(): void {
    if (this.stopped || this.restarting) return;
    this.restarting = true;
    this.up = false;
    this.sock?.destroy();
    this.sock = undefined;
    if (!this.downSince) {
      this.downSince = process.hrtime.bigint();
      this.emit("down");
    }
    const old = this.child;
    this.child = undefined;
    old?.kill("SIGKILL");
    this.restarts += 1;
    const backoff = Math.min(25 * 2 ** Math.min(this.restarts - 1, 6), 2000);
    setTimeout(() => {
      if (this.stopped) return;
      this.spawnChild();
      this.connectWithRetry()
        .then(() => {
          this.restarting = false;
          this.restarts = 0;
          const downtime_ms = Math.round(Number(process.hrtime.bigint() - this.downSince) / 1e6);
          this.downSince = 0n;
          this.emit("up", { downtime_ms });
        })
        .catch(() => {
          this.restarting = false;
          this.onDown();
        });
    }, backoff);
  }

  private onFrame(m: Record<string, unknown>): void {
    if (typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve({ ...m, rtt_us: Number((process.hrtime.bigint() - p.t0) / 1000n) });
      else p.reject(new Error(String(m.error)));
      return;
    }
    if (m.ev === "batch") this.emit("batch", m as unknown as BatchEvent);
    else if (m.ev === "consistency") this.emit("consistency", m);
    else if (m.ev === "anchor_failure") this.emit("anchor_failure", m);
  }

  private request(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { msg, resolve, reject, t0: process.hrtime.bigint() });
      if (this.up && this.sock) writeFrame(this.sock, { ...msg, id });
    });
  }

  openPlan(init: PlanInit): Promise<PlanReceipt> {
    const id = init.id ?? crypto.randomUUID();
    return this.request({ op: "open_plan", init: { ...init, id } }).then((r) => r.plan as PlanReceipt);
  }

  async sign(input: SignInput, idempotencyKey = crypto.randomUUID()): Promise<SignResult> {
    const res = (await this.request({ op: "sign", k: idempotencyKey, ...input })) as unknown as SignResult;
    res.receipt = { ...res.receipt, evidence: input.evidence };
    return res;
  }

  closePlan(planId: string): Promise<unknown> {
    return this.request({ op: "close_plan", plan_id: planId });
  }

  /** Failure injection: the signer's authority calls fail for `ms`. */
  failAuthority(ms: number): Promise<unknown> {
    return this.request({ op: "fail_authority", ms });
  }

  /** Failure injection: SIGKILL the signer process (it is restarted). */
  crash(): void {
    this.child?.kill("SIGKILL");
  }

  get isUp(): boolean {
    return this.up;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  stop(): void {
    this.stopped = true;
    this.sock?.destroy();
    this.child?.stdin?.end();
    this.child?.kill("SIGTERM");
    for (const p of this.pending.values()) p.reject(new Error("signer stopped"));
    this.pending.clear();
  }
}
