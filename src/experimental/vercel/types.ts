/**
 * Structural interfaces mirroring the Vercel AI SDK (`ai` package) shapes we
 * touch. AgentMint has zero runtime dependencies, so shipped code never imports
 * from `ai`; these local copies stand in for the SDK's own types and are a
 * strict subset of them — every field is named to match the SDK so an AI
 * SDK-shaped value satisfies the interface without adaptation.
 *
 * Verified against `ai@7.0.17` (see the module doc in ./index.ts). The fields
 * below are stable across AI SDK 6 and 7 for the surface we use.
 */

/**
 * Mirror of the SDK's `ToolExecutionOptions` — the second argument the AI SDK
 * passes to a tool's `execute(input, options)`. `messages`/`context` are
 * non-optional in the SDK but we only read `toolCallId` and forward the whole
 * object untouched, so we widen them to optional to also accept hand-built test
 * drivers and older SDK majors.
 */
export interface VercelToolCallOptions {
  /** ID of the tool call — correlates a receipt line to an exact AI SDK call. */
  toolCallId: string;
  /** Messages sent to the model to initiate the response with this tool call. */
  messages?: unknown[];
  /** Abort signal for the overall operation; tools use it to cancel work. */
  abortSignal?: AbortSignal;
  /** Tool context, as defined by the tool's context schema. */
  context?: unknown;
  /** Sandbox environment the tool operates in (SDK-internal). */
  experimental_sandbox?: unknown;
  [key: string]: unknown;
}

/** Mirror of the SDK's `ToolExecuteFunction`. */
export type VercelToolExecute = (
  input: any,
  options: VercelToolCallOptions,
) => unknown;

/**
 * Mirror of a single AI SDK `Tool` — only the fields we read. `execute` is
 * optional: provider-executed and client-side tools have none and must pass
 * through the wrapper untouched.
 */
export interface VercelTool {
  execute?: VercelToolExecute;
  [key: string]: unknown;
}

/** Mirror of the SDK's `ToolSet`. */
export type VercelToolSet = Record<string, VercelTool>;

/**
 * Mirror of the subset of the SDK's `StepResult` we read in `onStepFinish` —
 * step number, the model that produced the step, why it finished, and usage.
 */
export interface VercelStepResult {
  stepNumber?: number;
  model?: { provider?: string; modelId?: string };
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    [key: string]: unknown;
  };
  toolCalls?: ReadonlyArray<{
    toolName?: string;
    toolCallId?: string;
    input?: unknown;
  }>;
  toolResults?: ReadonlyArray<unknown>;
  [key: string]: unknown;
}

/** Composable `onStepFinish`/`onStepEnd` callback shape. */
export type VercelOnStepFinish = (
  step: VercelStepResult,
) => void | Promise<void>;

/** The tool call the AI SDK asks us to approve. */
export interface VercelToolCallInfo {
  toolName: string;
  toolCallId?: string;
  input?: unknown;
}

/** Argument shape of the SDK's generic `toolApproval` function. */
export interface VercelApprovalArgs {
  toolCall: VercelToolCallInfo;
  messages?: unknown[];
  [key: string]: unknown;
}

/** Mirror of the SDK's `ToolApprovalStatus`. */
export type VercelApprovalStatus =
  | "approved"
  | "denied"
  | "not-applicable"
  | "user-approval"
  | {
      type: "approved" | "denied" | "not-applicable" | "user-approval";
      reason?: string;
    };

/** The generic-function form of the SDK's `toolApproval` configuration. */
export type VercelToolApproval = (
  args: VercelApprovalArgs,
) => Promise<VercelApprovalStatus> | VercelApprovalStatus;
