import type { EnforcerFn } from "../../types.js";
import type {
  VercelTool,
  VercelToolCallOptions,
  VercelToolSet,
} from "../vercel/types.js";

/**
 * Low-level shim for Vercel AI SDK tool sets: wrap every tool's `execute` with
 * the enforcer. This is the shared primitive `harden()` and the first-class
 * `withAgentMint()` integration both build on.
 *
 * The AI SDK calls `execute(input, options)` where `options` (its
 * `ToolCallOptions`) carries `{ toolCallId, messages, abortSignal, ... }`. The
 * wrapper forwards `options` to the original tool untouched — so `abortSignal`
 * cancellation, `messages` context, and everything else keep working — and
 * passes `toolCallId` to the enforcer so it can stamp the receipt event with a
 * reference back to the exact tool call. Tools without an `execute` function
 * (provider-executed / client-side tools) are passed through unchanged.
 */
export function wrapAll(
  tools: VercelToolSet,
  enforcer: EnforcerFn,
): Record<string, VercelTool> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      if (typeof tool.execute !== "function") return [name, tool];
      const orig = tool.execute;
      const execute = (input: unknown, options?: VercelToolCallOptions) =>
        enforcer(
          name,
          (input as Record<string, unknown>) ?? {},
          () => Promise.resolve(orig(input, options as VercelToolCallOptions)),
          options?.toolCallId ? { toolCallId: options.toolCallId } : undefined,
        );
      return [name, { ...tool, execute }];
    }),
  );
}
