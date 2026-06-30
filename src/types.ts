import type { MerkleTree } from "./merkle.js";

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
  | "skipped";

// ── Spec Types ─────────────────────────────────────────────────────

export interface SpecPropertyConfig {
  cross_ref?: string;
  max_ref?: string;
  blocked_patterns?: string[];
  blocked_values?: string[];
  action?: RuleAction;
}

export interface SpecToolConfig {
  requires?: string[];
  action?: RuleAction;
  input?: { properties?: Record<string, SpecPropertyConfig> };
  output?: { properties?: Record<string, SpecPropertyConfig> };
}

export interface SpecBreakerConfig {
  loop?: { max_identical_calls: number; action?: RuleAction };
  velocity?: { max_calls_per_window: number; window_seconds: number; action?: RuleAction };
  cost?: { max_usd: number; action?: RuleAction };
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
    | "cost_breaker";
  tool: string;
  field?: string;
  expected?: string;
  actual?: string;
  details: string;
  action: RuleAction;
}

// ── Config ─────────────────────────────────────────────────────────

/** What the developer passes to harden() */
export interface AgentMintConfig {
  readonly spec?: AgentMintSpec;
  readonly bind?: Record<string, string>;
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly require?: readonly string[];
  readonly checkpoint?: readonly string[];
  readonly budget?: number;
  readonly timeout?: number;
  readonly retryLimit?: number;
  readonly silent?: boolean;
  readonly evidenceChain?: boolean;
  readonly mode?: "enforce" | "shadow";
  readonly receiptsDir?: string;
  readonly onCheckpoint?: (
    tool: string,
    params: Readonly<Record<string, unknown>>,
  ) => Promise<boolean>;
  readonly onBlock?: (tool: string, reason: string, details?: string) => void;
  readonly onWarn?: (tool: string, reason: string, details?: string) => void;
  readonly onKill?: (reason: string, state: Readonly<RunState>) => void;
  readonly costEstimator?: (
    tool: string,
    params: Readonly<Record<string, unknown>>,
    result: unknown,
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
}

// ── Block Response ─────────────────────────────────────────────────

export interface BlockResponse {
  readonly error: true;
  readonly tool: string;
  readonly message: string;
}

// ── Function Signatures ────────────────────────────────────────────

export type EnforcerFn = (
  tool: string,
  params: Record<string, unknown>,
  execute: () => Promise<unknown>,
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
  violations?: Array<{
    type: string;
    field?: string;
    details: string;
    action: string;
  }>;
}
