import type { MerkleTree } from "./merkle.js";
import type { PlanReceipt } from "./plan.js";

// ── Actions & Results ──────────────────────────────────────────────

/** Action to take when a rule fires */
export type RuleAction = "warn" | "block";

/** Result type for an enforcement decision */
export type EventResult =
  | "allowed"
  | "warned"
  | "blocked"
  | "held"
  | "approved"
  | "rejected"
  | "killed"
  | "skipped"
  /** A tool call that arrived after the run was killed — logged, never executed. */
  | "attempted_after_kill";

// ── Decision Trace (onDecision hook) ───────────────────────────────

/** The verdict enforce() reached for a single call. */
export type DecisionVerdict = "allow" | "deny" | "warn" | "hold" | "kill";

/** One gate check that enforce() actually evaluated, with its real result. */
export interface DecisionCheck {
  /** Check label, e.g. "allow list?", "requires?", "budget?". */
  name: string;
  /** Whether the call passed this check. */
  passed: boolean;
  /** Human-readable detail of what the check saw, from real engine state. */
  detail: string;
}

/**
 * The full decision for one enforce() call, delivered to config.onDecision as
 * the engine reaches its verdict. `checks` are the real checks that fired, in
 * evaluation order — not a simulation.
 */
export interface DecisionInfo {
  tool: string;
  verdict: DecisionVerdict;
  /** Rule/reason code for a non-allow verdict (e.g. "max_ref", "action_block"). */
  reason?: string;
  /** Human-readable detail from the deciding violation. */
  detail?: string;
  checks: DecisionCheck[];
}

// ── Spec Types ─────────────────────────────────────────────────────

export interface SpecPropertyConfig {
  cross_ref?: string;
  max_ref?: string;
  blocked_patterns?: string[];
  blocked_values?: string[];
  action?: RuleAction;
}

/** Per-tool cost estimate + optional hard cap on a single call. */
export interface SpecCostConfig {
  /** Static estimated USD cost for one call of this tool. */
  estimate_usd?: number;
  /** Hard cap: block/warn when a single call is estimated above this. */
  max_cost_usd?: number;
  /** Action when max_cost_usd is exceeded (default: block). */
  action?: RuleAction;
}

/** Per-tool usage caps within a single run. */
export interface SpecLimitsConfig {
  /** Max number of times this tool may run per run. */
  max_calls_per_run?: number;
  /** Action when the call cap is reached (default: block). */
  action?: RuleAction;
}

export interface SpecToolConfig {
  requires?: string[];
  action?: RuleAction;
  /**
   * Marks this tool as requiring human approval before it runs. Consumed by the
   * Vercel integration's spec-driven `toolApproval` policy (see
   * `src/experimental/vercel/`); tools with `requires_approval: true` (or a bare
   * `action: block`) are routed through `gate()`.
   */
  requires_approval?: boolean;
  input?: { properties?: Record<string, SpecPropertyConfig> };
  output?: { properties?: Record<string, SpecPropertyConfig> };
  cost?: SpecCostConfig;
  limits?: SpecLimitsConfig;
}

export interface SpecBreakerConfig {
  loop?: { max_identical_calls: number; action?: RuleAction };
  velocity?: { max_calls_per_window: number; window_seconds: number; action?: RuleAction };
  /** Legacy post-hoc cost breaker (kept for backward compatibility). */
  cost?: { max_usd: number; action?: RuleAction };
  /** Per-run budget guardrail, enforced pre-flight at the tool boundary. */
  budget?: { max_total_usd: number; action?: RuleAction };
}

export interface AgentMintSpec {
  version: string;
  defaults?: { action?: RuleAction };
  tools?: Record<string, SpecToolConfig>;
  breakers?: SpecBreakerConfig;
}

// ── Session Store ──────────────────────────────────────────────────

export interface SessionStore {
  inputs: Map<string, Record<string, unknown>>;
  outputs: Map<string, unknown>;
  callHistory: Array<{
    tool: string;
    timestamp: number;
    args: Record<string, unknown>;
    argsHash: string;
  }>;
}

// ── Violation ──────────────────────────────────────────────────────

export interface Violation {
  type:
    | "cross_ref"
    | "max_ref"
    | "blocked_pattern"
    | "blocked_value"
    | "requires"
    | "loop_breaker"
    | "velocity_breaker"
    | "cost_breaker"
    | "cost_cap"
    | "usage_cap"
    | "budget_cap";
  tool: string;
  field?: string;
  expected?: string;
  actual?: string;
  /** Rule reference path for cross_ref/max_ref (e.g. "lookup.output.balance"). */
  ref?: string;
  /** Velocity-breaker window, so inference never re-parses the details string. */
  windowSeconds?: number;
  details: string;
  action: RuleAction;
}

/**
 * A rule firing recorded ON the event/receipt itself — structured, not a
 * details string. Covers every engine rule type: the spec/breaker rules
 * ({@link Violation}) plus the config-level denials that never construct a
 * Violation object (bind, action_block, deny/allow lists).
 */
export interface ReceiptViolation {
  type:
    | Violation["type"]
    | "bind_violation"
    | "action_block"
    | "denied"
    | "not_in_scope"
    | "plan_policy";
  tool: string;
  field?: string;
  expected?: string;
  actual?: string;
  ref?: string;
  windowSeconds?: number;
  details: string;
  action: RuleAction;
}

// ── Config ─────────────────────────────────────────────────────────

/** What the developer passes to harden() */
export interface AgentMintConfig {
  readonly spec?: AgentMintSpec;
  /**
   * Signed plan (policy envelope) this run operates under. Every call is
   * evaluated against the plan (checkpoints block, scope allows, delegates_to
   * restricts by agent, expiry denies), and every signed decision receipt
   * binds to it via plan_id + plan_signature + policy_hash.
   */
  readonly plan?: PlanReceipt;
  /** Acting agent identity checked against plan.delegates_to. Default "agent". */
  readonly agent?: string;
  readonly bind?: Record<string, string>;
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly require?: readonly string[];
  readonly checkpoint?: readonly string[];
  /** Per-run budget in USD. Beats YAML `breakers.budget.max_total_usd`. */
  readonly budget?: number;
  /** Per-tool hard cap on a single call's estimated cost. Beats YAML `cost.max_cost_usd`. */
  readonly costCaps?: Record<string, number>;
  /** Per-tool usage caps within a run. Beats YAML `limits.max_calls_per_run`. */
  readonly toolLimits?: Record<string, { maxCallsPerRun?: number }>;
  readonly timeout?: number;
  readonly retryLimit?: number;
  /** Human-in-the-loop approval for checkpointed tools (see gate()). */
  readonly gate?: {
    channel?: "console" | "slack" | "webhook";
    ttl?: number;
    webhookUrl?: string;
  };
  readonly silent?: boolean;
  readonly evidenceChain?: boolean;
  /**
   * Enable signed decision receipts. When present, every enforce() decision
   * emits one Ed25519-signed, hash-chained {@link DecisionReceipt}, retrievable
   * via harden()'s __receipts() / __verifyReceipts().
   */
  readonly signing?: { privateKeyPem: string };
  readonly mode?: "enforce" | "shadow";
  readonly receiptsDir?: string;
  readonly onCheckpoint?: (
    tool: string,
    params: Readonly<Record<string, unknown>>,
  ) => Promise<boolean>;
  readonly onBlock?: (tool: string, reason: string, details?: string) => void;
  readonly onWarn?: (tool: string, reason: string, details?: string) => void;
  readonly onKill?: (reason: string, state: Readonly<RunState>) => void;
  /**
   * Engine-internals hook: fired once per enforce() call as the verdict is
   * reached, with the real checks that fired. Used to surface the gate pipeline
   * (see the trace demo). Purely observational — it cannot change the decision.
   */
  readonly onDecision?: (info: DecisionInfo) => void;
  /**
   * Dynamic cost estimator. Beats static YAML `cost.estimate_usd`.
   *
   * Called pre-flight (with `result: undefined`) to decide budget guardrails,
   * and post-execution (with the real `result`) to account actual cost. Must be
   * pure and deterministic — the same inputs must always return the same number.
   * The optional `state` argument exposes run context (e.g. cumulative cost,
   * per-tool call counts) for usage- or state-dependent pricing.
   */
  readonly costEstimator?: (
    tool: string,
    params: Readonly<Record<string, unknown>>,
    result: unknown,
    state?: Readonly<RunState>,
  ) => number;
}

// ── Run State ──────────────────────────────────────────────────────

export interface RunState {
  runId: string;
  startedAt: number;
  status: "running" | "completed" | "killed";
  killReason?: string;
  totalCost: number;
  callCount: number;
  executedCount: number;
  blockedCount: number;
  warnedCount: number;
  heldCount: number;
  killedCount: number;
  skippedCount: number;
  retryCounts: Record<string, number>;
  completedSteps: Set<string>;
  boundValues: Readonly<Record<string, string>>;
  events: Event[];
  retrievedData: string[];
  session: SessionStore;
  /** Merkle evidence chain, present only when config.evidenceChain is enabled */
  evidence?: MerkleTree;
  /** Signed decision-receipt context, present only when config.signing is enabled. */
  decisionContext?: import("./receipt-decision.js").DecisionContext;
}

// ── Event ──────────────────────────────────────────────────────────

export interface Event {
  readonly timestamp: string;
  readonly elapsed: string;
  readonly tool: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly result: EventResult;
  readonly reason?: string;
  readonly details?: string;
  readonly cost?: number;
  readonly durationMs?: number;
  /** Pre-flight estimated USD cost of this call (budget guardrails). */
  readonly estimate?: number;
  /** Cumulative run cost in USD after this call. */
  readonly cumulative?: number;
  /** 1-based index of this call among calls to the same tool this run. */
  readonly callIndex?: number;
  /**
   * Framework tool-call id (e.g. the Vercel AI SDK's `toolCallId`), threaded
   * through so an auditor can correlate this receipt line to an exact tool call
   * in the framework's own trace. Optional — absent for calls that carry no id.
   */
  readonly callRef?: string;
  /** Structured rule firings behind a non-allowed result (never a bare string). */
  readonly violations?: ReadonlyArray<ReceiptViolation>;
}

// ── Block Response ─────────────────────────────────────────────────

export interface BlockResponse {
  readonly error: true;
  readonly tool: string;
  readonly message: string;
}

// ── Function Signatures ────────────────────────────────────────────

/** Optional per-call metadata an adapter can hand to the enforcer. */
export interface EnforcerMeta {
  /** Framework tool-call id (e.g. the Vercel AI SDK's `toolCallId`). */
  toolCallId?: string;
}

export type EnforcerFn = (
  tool: string,
  params: Record<string, unknown>,
  execute: () => Promise<unknown>,
  meta?: EnforcerMeta,
) => Promise<unknown>;

// ── Report ─────────────────────────────────────────────────────────

export interface ReportOptions {
  readonly last?: string;
  readonly format?: "text" | "json";
}

// ── AERF Record ────────────────────────────────────────────────────

export interface AERFRecord {
  version: "0.1.0";
  runId: string;
  boundValues: Record<string, string>;
  startedAt: string;
  status: RunState["status"];
  mode: "enforce" | "shadow";
  events: ReadonlyArray<{
    tool: string;
    result: EventResult;
    reason?: string;
    details?: string;
    boundParams?: Record<string, string>;
    /** Framework tool-call id, when the call carried one. */
    callRef?: string;
  }>;
  summary: {
    calls: number;
    executed: number;
    blocked: number;
    warned: number;
    held: number;
    skipped: number;
    cost: number | null;
    budget: number | null;
    elapsedSeconds: number;
  };
  requiredSteps?: Array<{ tool: string; completed: boolean }>;
  /** Merkle root over all events, present only when evidenceChain is enabled */
  evidenceRoot?: string;
}

// ── Decision Receipt ───────────────────────────────────────────────

/**
 * A signed, hash-chained receipt for a single enforce() decision. Emitted once
 * per decision when config.signing is enabled. Stores a HASH of the params,
 * never the raw params. Ed25519 signature covers the canonical receipt minus
 * the post-issuance fields (here, only `signature`).
 */
export interface DecisionReceipt {
  /** Unique receipt id (crypto.randomUUID). */
  id: string;
  /** The run this receipt belongs to. */
  run_id: string;
  /** Monotonic, 1-based sequence number within the run. */
  seq: number;
  /** The tool the decision was about. */
  action: string;
  /** SHA-256 hex of canonical(params) — never the raw params. */
  params_hash: string;
  /** True ONLY for allowed/approved decisions. */
  in_policy: boolean;
  /** Human-readable rule name or kill reason. Required for every non-allowed result. */
  policy_reason: string;
  /** SHA-256 hex of canonical(spec), present only when a spec is configured. */
  spec_hash?: string;
  /** Plan this decision binds to, present when config.plan is set. */
  plan_id?: string;
  /** The plan's signature — direct receipt→plan binding. */
  plan_signature?: string;
  /** SHA-256 hex of canonical {scope, checkpoints, delegates_to} of the plan. */
  policy_hash?: string;
  /** ISO 8601 timestamp the decision was observed. */
  observed_at: string;
  /** Issuer key id (first 16 hex of SHA-256(raw public key)). */
  key_id: string;
  /** SHA-256 hex of the previous receipt's canonical bytes (incl. its signature). Omitted on genesis. */
  previous_receipt_hash?: string;
  /** Structured rule firings behind this decision. Part of the signed payload. */
  violations?: ReceiptViolation[];
  /** Ed25519 signature, lowercase hex, over the canonical stripped receipt. */
  signature: string;
}

/** Result of verifying a chain of decision receipts. */
export interface ReceiptChainVerification {
  ok: boolean;
  /** 0-based index of the first broken receipt, when ok is false. */
  brokenAt?: number;
  /** Human-readable explanation of the break. */
  reason?: string;
}

// ── Merkle ─────────────────────────────────────────────────────────

export interface MerkleProof {
  leaf: string;
  index: number;
  siblings: ReadonlyArray<{ hash: string; position: "left" | "right" }>;
  root: string;
}

// ── JSONL ──────────────────────────────────────────────────────────

export interface JSONLEvent {
  timestamp: string;
  runId: string;
  tool: string;
  result: string;
  reason?: string;
  details?: string;
  params?: Record<string, unknown>;
  cost?: number;
  durationMs?: number;
  estimate?: number;
  cumulative?: number;
  callIndex?: number;
  callRef?: string;
  // NOTE: callRef mirrors Event.callRef — the framework tool-call id.
  violations?: Array<{
    type: string;
    field?: string;
    expected?: string;
    actual?: string;
    details: string;
    action: string;
  }>;
}
