import { randomBytes } from "node:crypto";
import type {
  AgentMintConfig,
  BlockResponse,
  Event,
  EventResult,
  RunState,
} from "./types.js";
import { redact } from "./redact.js";
import { createSession } from "./session.js";
import { MerkleTree, canonicalize } from "./merkle.js";

const CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generateRunId(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (byte) => CHARSET[byte % 36]);
  return "amr_" + chars.join("");
}

export function createRunState(config: AgentMintConfig): RunState {
  return {
    runId: generateRunId(),
    startedAt: Date.now(),
    status: "running",
    totalCost: 0,
    callCount: 0,
    executedCount: 0,
    blockedCount: 0,
    warnedCount: 0,
    heldCount: 0,
    killedCount: 0,
    skippedCount: 0,
    retryCounts: {},
    completedSteps: new Set(),
    boundValues: Object.freeze({ ...config.bind }),
    events: [],
    retrievedData: [],
    session: createSession(),
    ...(config.evidenceChain ? { evidence: new MerkleTree() } : {}),
  };
}

export function logEvent(
  state: RunState,
  tool: string,
  params: Record<string, unknown>,
  result: EventResult,
  opts?: { reason?: string; details?: string; cost?: number; durationMs?: number },
): Event {
  const redacted = redact(params, Object.keys(state.boundValues));
  const elapsed = ((Date.now() - state.startedAt) / 1000).toFixed(1) + "s";
  const event: Event = {
    timestamp: new Date().toISOString(),
    elapsed,
    tool,
    params: redacted,
    result,
    ...(opts?.reason !== undefined && { reason: opts.reason }),
    ...(opts?.details !== undefined && { details: opts.details }),
    ...(opts?.cost !== undefined && { cost: opts.cost }),
    ...(opts?.durationMs !== undefined && { durationMs: opts.durationMs }),
  };
  state.events.push(event);
  // Append a tamper-evident leaf to the Merkle evidence chain when enabled
  if (state.evidence) {
    state.evidence.addLeaf(canonicalize(event));
  }
  return event;
}

export function blockResponse(tool: string, message: string): BlockResponse {
  return { error: true as const, tool, message };
}
