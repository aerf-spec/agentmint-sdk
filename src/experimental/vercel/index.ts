/**
 * First-class Vercel AI SDK integration for AgentMint.
 *
 * `withAgentMint()` binds ONE AgentMint run — one {@link RunState}, one session,
 * one receipt — to one `generateText` / `streamText` / Agent run, including
 * multi-step tool loops. Wrap your tools with `am.tools(...)`, feed
 * `am.onStepFinish` to the generation call for step/model/usage metadata, and
 * read back a single `AERFRecord` for the whole run.
 *
 * Zero runtime dependency on `ai`: everything here uses the local structural
 * interfaces in ./types.js. The `ai` package is a devDependency used only by
 * tests and the example.
 *
 * Verified against `ai@7.0.17`. Per-tool `needsApproval` is deprecated in AI SDK
 * 6/7; approval lives on `generateText`/`streamText` as `toolApproval`, which
 * `am.toolApproval()` bridges to `gate()` (AI SDK 7 adds opt-in HMAC-signed
 * approvals, surfaced behind `options.signature`). Future work: a durable
 * `WorkflowAgent` binding that receipts each workflow step, not just tool calls.
 *
 * @example
 * ```ts
 * import { withAgentMint } from "@npmsai/agentmint/vercel";
 *
 * const am = withAgentMint({ spec: "agentmint.spec.yaml", mode: "enforce" });
 * const result = await generateText({
 *   model,
 *   tools: am.tools({ issueRefund, lookupOrder }),
 *   stopWhen: stepCountIs(5),
 *   onStepFinish: am.onStepFinish,
 * });
 * const receipt = am.receipt();
 * am.writeJSONL("./receipts/run.jsonl");
 * ```
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AERFRecord,
  AgentMintConfig,
  AgentMintSpec,
  BlockResponse,
  EnforcerFn,
  Event,
  RunState,
} from "../../types.js";
import { createRunState } from "../../log.js";
import { buildRecord, formatReceipt } from "../../receipt.js";
import { formatJSONL } from "../../jsonl.js";
import { loadSpec } from "../../kernel/spec.js";
import { validateGuardrails } from "../../kernel/budget.js";
import { enforce } from "../enforce.js";
import { wrapAll } from "../adapters/vercel.js";
import type { EvidenceChain } from "../harden.js";
import {
  createApprovalBridge,
  type ApprovalDecision,
  type ToolApprovalOptions,
  type ToolApprovalPolicy,
} from "./approval.js";
import type {
  VercelOnStepFinish,
  VercelStepResult,
  VercelToolApproval,
  VercelToolSet,
} from "./types.js";

// ── Config ──────────────────────────────────────────────────────────

/**
 * Options for {@link withAgentMint}. A superset of the wedge's
 * {@link AgentMintConfig}, with two Vercel-specific twists:
 *  - `spec` accepts a path/content string (loaded via `loadSpec`) as well as a
 *    parsed {@link AgentMintSpec}.
 *  - `onBlock` selects how a blocked tool call surfaces to the model loop.
 *
 * The wedge's own `onBlock` *callback* is intentionally omitted here to avoid a
 * name clash; use `onWarn` / `onDecision` for observation.
 */
export interface WithAgentMintOptions
  extends Omit<AgentMintConfig, "spec" | "onBlock"> {
  /** Spec as a parsed object, or a path / YAML string handed to `loadSpec`. */
  readonly spec?: string | AgentMintSpec;
  /**
   * What a blocked call returns to the AI SDK tool loop:
   *  - `"return"` (default): resolve with a structured {@link BlockResponse} so
   *    the model sees the denial and the loop continues or stops naturally.
   *  - `"throw"`: throw {@link AgentMintBlockedError}, aborting the tool call.
   */
  readonly onBlock?: "return" | "throw";
}

/** Thrown by a wrapped tool when `onBlock: "throw"` and the call is blocked. */
export class AgentMintBlockedError extends Error {
  readonly tool: string;
  readonly block: BlockResponse;
  constructor(block: BlockResponse) {
    super(block.message);
    this.name = "AgentMintBlockedError";
    this.tool = block.tool;
    this.block = block;
  }
}

// ── Step annotations ────────────────────────────────────────────────

/** AI SDK metadata captured from one finished step. */
export interface StepAnnotation {
  stepNumber?: number;
  model?: { provider?: string; modelId?: string };
  finishReason?: string;
  usage?: VercelStepResult["usage"];
  /** toolCallIds emitted in this step — the join key back to receipt events. */
  toolCallIds: string[];
}

/** The composable `onStepFinish` callback, with its `(userCallback)` overload. */
export interface OnStepFinish {
  /** Direct use: the AI SDK calls this with a finished step. */
  (step: VercelStepResult): void;
  /** Composition: wrap a user callback, returning a merged callback. */
  (userCallback: VercelOnStepFinish): VercelOnStepFinish;
}

// ── Public handle ───────────────────────────────────────────────────

/** The run-scoped handle returned by {@link withAgentMint}. */
export interface AgentMintRun {
  /**
   * Wrap an AI SDK `ToolSet`, binding every tool's `execute` to this run's
   * enforcer. Generic `T` in and out preserves the caller's exact ToolSet type
   * (including the SDK's own `Tool<...>` types) so AI SDK tool-part inference is
   * not destroyed.
   */
  tools<T extends Record<string, unknown>>(toolSet: T): T;
  /** Composable `onStepFinish` — see {@link OnStepFinish}. */
  readonly onStepFinish: OnStepFinish;
  /**
   * Build the AI SDK `toolApproval` hook, with `gate()` as the decision-maker.
   * Pass a policy (`"spec"` — the default — or `{ tools, when }`) and optional
   * gate/HMAC options. Every decision is chained onto the gate hash chain and
   * recorded on this run's receipt.
   */
  toolApproval(
    policy?: ToolApprovalPolicy,
    options?: ToolApprovalOptions,
  ): VercelToolApproval;
  /**
   * Chain an out-of-band approval decision (e.g. from a `useChat` server route)
   * onto this run's receipt. Records the same `held` → `approved`/`rejected`
   * events as the `toolApproval` bridge.
   */
  recordApproval(decision: ApprovalDecision): void;
  /** Build the single {@link AERFRecord} for the whole run. */
  receipt(): AERFRecord;
  /** The rendered terminal receipt box for this run. */
  formatReceipt(): string;
  /** The run's events serialized as JSONL evidence. */
  jsonl(): string;
  /** Write the run's JSONL evidence to `path` (parent dirs created). */
  writeJSONL(path: string): void;
  /** AI SDK step metadata captured via {@link onStepFinish}. */
  steps(): StepAnnotation[];
  /**
   * The run's Merkle evidence chain — the same {@link EvidenceChain} handle
   * `harden()`'s `__evidence()` returns — for a per-event inclusion proof.
   * `null` when the chain is off (pass `evidenceChain: true` to enable it).
   */
  evidence(): EvidenceChain | null;
  /** The live run state (advanced / testing). */
  state(): RunState;
  /** The run id. */
  readonly runId: string;
}

function resolveSpec(spec: WithAgentMintOptions["spec"]): AgentMintSpec | undefined {
  if (spec === undefined) return undefined;
  return typeof spec === "string" ? loadSpec(spec) : spec;
}

/** True for the exact `{ error: true, tool, message }` shape `enforce` returns. */
function isBlockResponse(value: unknown): value is BlockResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { error?: unknown }).error === true &&
    typeof (value as { tool?: unknown }).tool === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/**
 * Bind a single AgentMint run to a Vercel AI SDK generation. Each call creates
 * an isolated {@link RunState} and session — two `withAgentMint()` handles never
 * share state, so concurrent runs stay independent.
 */
export function withAgentMint(options: WithAgentMintOptions = {}): AgentMintRun {
  const { onBlock = "return", spec: specInput, ...rest } = options;
  const config: AgentMintConfig = { ...rest, spec: resolveSpec(specInput) };

  // Fail loudly at setup if budget guardrails are misconfigured (mirrors
  // harden()), rather than surfacing a confusing decision mid-run.
  validateGuardrails(config, config.spec);

  const state = createRunState(config);
  const steps: StepAnnotation[] = [];
  const approval = createApprovalBridge(state, config);

  const enforcer: EnforcerFn = async (tool, params, exec, meta) => {
    const result = await enforce(tool, params, exec, config, state, meta);
    if (onBlock === "throw" && isBlockResponse(result)) {
      throw new AgentMintBlockedError(result);
    }
    return result;
  };

  const recordStep = (step: VercelStepResult): void => {
    steps.push({
      stepNumber: step.stepNumber,
      model: step.model,
      finishReason: step.finishReason,
      usage: step.usage,
      toolCallIds: (step.toolCalls ?? [])
        .map((c) => c.toolCallId)
        .filter((id): id is string => typeof id === "string"),
    });
  };

  // Dual-purpose: called directly by the AI SDK with a step, OR called with a
  // user callback to produce a merged callback.
  const onStepFinish = ((arg: VercelStepResult | VercelOnStepFinish) => {
    if (typeof arg === "function") {
      const user = arg;
      return (step: VercelStepResult) => {
        recordStep(step);
        return user(step);
      };
    }
    recordStep(arg);
  }) as OnStepFinish;

  const finalize = (): void => {
    if (state.status === "running") state.status = "completed";
  };

  return {
    runId: state.runId,
    onStepFinish,
    toolApproval: approval.toolApproval,
    recordApproval: approval.recordApproval,
    tools<T extends Record<string, unknown>>(toolSet: T): T {
      return wrapAll(toolSet as unknown as VercelToolSet, enforcer) as unknown as T;
    },
    receipt(): AERFRecord {
      finalize();
      return buildRecord(state, config);
    },
    formatReceipt(): string {
      finalize();
      return formatReceipt(state, config);
    },
    jsonl(): string {
      return formatJSONL(state.events as Event[], state.runId);
    },
    writeJSONL(path: string): void {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, formatJSONL(state.events as Event[], state.runId) + "\n");
    },
    steps(): StepAnnotation[] {
      return steps.map((s) => ({ ...s }));
    },
    evidence(): EvidenceChain | null {
      const tree = state.evidence;
      if (!tree) return null;
      return {
        root: tree.build(),
        leafCount: state.events.length,
        getProof: (index: number) => tree.getProof(index),
      };
    },
    state(): RunState {
      return state;
    },
  };
}

export type {
  ApprovalBridge,
  ApprovalDecision,
  ToolApprovalOptions,
  ToolApprovalPolicy,
} from "./approval.js";

export type {
  VercelTool,
  VercelToolSet,
  VercelToolCallOptions,
  VercelStepResult,
  VercelOnStepFinish,
  VercelToolApproval,
  VercelApprovalStatus,
  VercelApprovalArgs,
} from "./types.js";
