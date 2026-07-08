/**
 * gate() ↔ AI SDK tool-approval bridge.
 *
 * AgentMint's hash-chained `gate()` becomes the decision-maker behind the AI
 * SDK's human-in-the-loop tool-approval flow. `toolApproval(policy)` returns the
 * generic-function form the SDK's `toolApproval` option accepts; each decision
 * comes from `gate()`, is appended to the gate hash chain (by `gate()` itself),
 * and is recorded as event(s) on the run receipt — a `held` marker, then an
 * `approved` or `rejected` event carrying the gate hash. On denial the SDK never
 * calls the tool's `execute`, so the receipt shows the denial and no tool event.
 *
 * `recordApproval(decision)` chains an out-of-band decision (e.g. a `useChat`
 * server route that resolves approval elsewhere) onto the same receipt.
 *
 * Zero runtime dependency on `ai`: the returned function matches the SDK's
 * `ToolApprovalConfiguration` generic-function shape structurally.
 */
import type { Readable } from "node:stream";
import type { AgentMintConfig, RunState } from "../../types.js";
import { logEvent } from "../../log.js";
import { gate } from "../../gate.js";
import type {
  VercelApprovalArgs,
  VercelApprovalStatus,
  VercelToolApproval,
} from "./types.js";

/** Which tool calls to route through `gate()`. */
export type ToolApprovalPolicy =
  /** Spec-driven: gate tools the spec marks `action: block` or `requires_approval: true`. */
  | "spec"
  /** Explicit: gate by name and/or a predicate. Empty object gates every tool. */
  | {
      tools?: string[];
      when?: (tool: string, input: unknown) => boolean;
    };

/** Overrides for the `gate()` call + audit/HMAC options. */
export interface ToolApprovalOptions {
  channel?: "console" | "slack" | "webhook";
  ttl?: number;
  webhookUrl?: string;
  /**
   * Embed the AgentMint gate-decision hash into the approval status `reason`, so
   * it rides along in the approval payload the model/audit sees. Portable across
   * AI SDK 6 and 7 — it uses `reason`, present in both — and complements the
   * SDK-7 native `experimental_toolApprovalSecret` HMAC (which binds the request,
   * not the response).
   */
  signature?: boolean;
  /** Test/embedding hook: read the console gate response from here. */
  input?: Readable;
  /** Test/embedding hook: write the console gate prompt here. */
  output?: NodeJS.WritableStream;
}

/** A resolved approval decision, for {@link ApprovalBridge.recordApproval}. */
export interface ApprovalDecision {
  tool: string;
  approved: boolean;
  approver?: string;
  reason?: string;
  /** Gate hash-chain link for this decision. */
  hash?: string;
  /** AI SDK toolCallId, correlating the decision to the tool call. */
  toolCallId?: string;
  /** Context shown to the approver (the tool input). */
  context?: Record<string, unknown>;
}

export interface ApprovalBridge {
  toolApproval(
    policy?: ToolApprovalPolicy,
    options?: ToolApprovalOptions,
  ): VercelToolApproval;
  recordApproval(decision: ApprovalDecision): void;
}

function asContext(input: unknown): Record<string, unknown> {
  return input && typeof input === "object"
    ? (input as Record<string, unknown>)
    : { input };
}

function shortHash(hash?: string): string {
  return hash ? `gate:${hash.slice(0, 16)}…` : "gate:—";
}

function approvalDetails(d: ApprovalDecision): string {
  const who = d.approved
    ? `by ${d.approver ?? "unknown"}`
    : d.reason
      ? `reason: ${d.reason}`
      : "denied";
  return `${who} · ${shortHash(d.hash)}`;
}

/** Build the approval bridge bound to one run's state + config. */
export function createApprovalBridge(
  state: RunState,
  config: Readonly<AgentMintConfig>,
): ApprovalBridge {
  const recordApproval = (d: ApprovalDecision): void => {
    const ctx = d.context ?? {};
    // held marker first, so the receipt shows the gate event(s) before the tool
    // event that (only on approval) follows when the SDK runs execute().
    state.heldCount++;
    logEvent(state, d.tool, ctx, "held", {
      reason: "approval_requested",
      ...(d.toolCallId ? { callRef: d.toolCallId } : {}),
    });
    if (d.approved) {
      logEvent(state, d.tool, ctx, "approved", {
        reason: "gate_approved",
        details: approvalDetails(d),
        ...(d.toolCallId ? { callRef: d.toolCallId } : {}),
      });
    } else {
      state.blockedCount++;
      logEvent(state, d.tool, ctx, "rejected", {
        reason: "gate_rejected",
        details: approvalDetails(d),
        ...(d.toolCallId ? { callRef: d.toolCallId } : {}),
      });
    }
  };

  const inScope = (
    tool: string,
    input: unknown,
    policy: ToolApprovalPolicy,
  ): boolean => {
    if (policy === "spec") {
      const cfg = config.spec?.tools?.[tool];
      return !!cfg && (cfg.action === "block" || cfg.requires_approval === true);
    }
    const hasTools = Array.isArray(policy.tools);
    const hasWhen = typeof policy.when === "function";
    if (!hasTools && !hasWhen) return true; // empty policy → gate everything
    return (
      (hasTools && policy.tools!.includes(tool)) ||
      (hasWhen && policy.when!(tool, input))
    );
  };

  const toolApproval = (
    policy: ToolApprovalPolicy = "spec",
    options: ToolApprovalOptions = {},
  ): VercelToolApproval => {
    return async (args: VercelApprovalArgs): Promise<VercelApprovalStatus> => {
      const tool = args.toolCall.toolName;
      const input = args.toolCall.input;
      const toolCallId = args.toolCall.toolCallId;
      if (!inScope(tool, input, policy)) return "not-applicable";

      const context = asContext(input);
      const decision = await gate({
        action: tool,
        context,
        channel: options.channel ?? config.gate?.channel,
        ttl: options.ttl ?? config.gate?.ttl,
        webhookUrl: options.webhookUrl ?? config.gate?.webhookUrl,
        ...(options.input ? { input: options.input } : {}),
        ...(options.output ? { output: options.output } : {}),
      });

      recordApproval({
        tool,
        approved: decision.approved,
        approver: decision.approver,
        reason: decision.reason,
        hash: decision.hash,
        toolCallId,
        context,
      });

      const sig = options.signature ? `agentmint-sig=${decision.hash}` : undefined;
      if (decision.approved) {
        return sig ? { type: "approved", reason: sig } : "approved";
      }
      const reason = [decision.reason, sig].filter(Boolean).join(" · ") ||
        "denied by AgentMint gate";
      return { type: "denied", reason };
    };
  };

  return { toolApproval, recordApproval };
}
