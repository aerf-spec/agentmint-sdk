# Vercel AI SDK integration — PLAN

First-class integration under `src/experimental/vercel/`, exposed as the
`@npmsai/agentmint/vercel` subpath. Zero runtime deps: shipped code uses local
structural interfaces that mirror AI SDK shapes; `ai`/`zod` are devDependencies
used only for tests and the example.

## Version verified against

- Installed: **`ai@7.0.17`** (npm `latest`) + `zod@4.4.3`, both `devDependencies`.
- Ground truth = the shipped `.d.ts` of that exact version, read directly from
  `node_modules/@ai-sdk/provider-utils/dist/index.d.ts` and
  `node_modules/ai/dist/index.d.ts`. The hosted docs site 403s through the
  build proxy, so the type declarations (the version we actually compile
  against) are the authority here.

### Discrepancies with the prompt (docs/reality win — flagged, not guessed)

1. **"6.x stable vs 7.x beta".** As of now npm `latest` = `7.0.17` (7.x is
   GA/stable). `ai-v6` (6.0.221) and `ai-v5` (5.0.210) are the older pinned
   dist-tags. `ai@latest` therefore installs **7.x**. We build against 7.x and
   keep our structural interfaces a strict subset so 6.x shapes still satisfy
   them (the fields we touch — `execute(input, options)`, `toolCallId`,
   `abortSignal`, step `model`/`usage`/`finishReason` — are unchanged across
   6→7).
2. **`MockLanguageModelV2`.** v7's `ai/test` exports **`MockLanguageModelV3`**
   and **`MockLanguageModelV4`** (no `...V2`). `generateText`'s `model` union is
   `GlobalProviderModelId | LanguageModelV4 | LanguageModelV3 | LanguageModelV2`,
   so a V2 model would still be *accepted*, but the mock class isn't exported.
   Integration tests use **`MockLanguageModelV3`** from `ai/test`.
3. **`needsApproval` on tools.** Deprecated in both 6 and 7:
   `BaseTool.needsApproval` is annotated *"@deprecated Tool approval is handled
   on a `generateText` / `streamText` level now."* Approval config lives on
   `generateText`/`streamText` as **`toolApproval`**. We bridge into
   `toolApproval`, never `needsApproval`.
4. **`onStepFinish`.** In v7 it is a *deprecated alias* for `onStepEnd`; both are
   still accepted by `generateText`/`streamText` and receive the same
   `StepResult`. We keep the public name `am.onStepFinish` (works on 6 and 7)
   and it is assignable to either option.
5. **HMAC-signed approvals** are v7-only: `experimental_toolApprovalSecret` on
   `generateText`/`streamText` and a `signature` field on `ToolApprovalRequest`.
   We surface this behind a capability check so 6.x callers are unaffected.

## Structural interfaces we will define (`src/experimental/vercel/types.ts`)

Mirrors of the AI SDK shapes, kept minimal (only the fields we read/forward).
Names chosen to read like the SDK; the `Vercel` prefix marks them as our local
copies.

```ts
// mirror of ToolExecutionOptions (provider-utils). messages/context are
// non-optional in the SDK, but we only READ toolCallId and FORWARD the whole
// object, so we widen them to optional to accept hand-built test drivers.
interface VercelToolCallOptions {
  toolCallId: string;
  messages?: unknown[];
  abortSignal?: AbortSignal;
  context?: unknown;
  experimental_sandbox?: unknown;
}

// mirror of ToolExecuteFunction (input, options) => result | Promise | AsyncIterable
type VercelToolExecute = (input: any, options: VercelToolCallOptions) => unknown;

// mirror of a single AI SDK Tool (the fields we care about). execute optional:
// provider-executed / client-side tools have none and must pass through.
interface VercelTool {
  execute?: VercelToolExecute;
  [key: string]: unknown;
}
type VercelToolSet = Record<string, VercelTool>;

// mirror of StepResult subset — onStepFinish payload
interface VercelStepResult {
  stepNumber?: number;
  model?: { provider?: string; modelId?: string };
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    [k: string]: unknown;
  };
  toolCalls?: ReadonlyArray<{ toolName?: string; toolCallId?: string; input?: unknown }>;
  toolResults?: ReadonlyArray<unknown>;
  [k: string]: unknown;
}
type VercelOnStepFinish = (step: VercelStepResult) => void | Promise<void>;

// mirror of the generic ToolApprovalConfiguration function form
interface VercelToolCallInfo { toolName: string; toolCallId?: string; input?: unknown }
interface VercelApprovalArgs {
  toolCall: VercelToolCallInfo;
  messages?: unknown[];
  [k: string]: unknown;
}
type VercelApprovalStatus =
  | "approved" | "denied" | "not-applicable" | "user-approval"
  | { type: "approved" | "denied" | "not-applicable" | "user-approval"; reason?: string };
type VercelToolApproval = (args: VercelApprovalArgs) => Promise<VercelApprovalStatus> | VercelApprovalStatus;
```

Confirmed against the SDK:
- `ToolExecutionOptions` = `{ toolCallId; messages: ModelMessage[]; abortSignal?; context; experimental_sandbox? }`.
- `ToolExecuteFunction` = `(input, options: ToolExecutionOptions) => AsyncIterable | PromiseLike | value`.
- `ToolSet` = `Record<string, Tool & Pick<Tool,'execute'|...>>`.
- `StepResult` has `stepNumber`, `model: { provider; modelId }`, `finishReason`,
  `usage: LanguageModelUsage`, `toolCalls`, `toolResults`.
- `GenericToolApprovalFunction` receives `{ toolCall: TypedToolCall; tools; toolsContext; runtimeContext; messages }` and returns `MaybePromiseLike<ToolApprovalStatus>`.
- `ToolApprovalStatus` = `undefined | 'not-applicable' | 'approved' | 'denied' | 'user-approval' | {type; reason?}`.
- `ToolApprovalRequest` carries optional `signature` (HMAC), populated only when `experimental_toolApprovalSecret` is set.

## Type-seam changes (backward-compatible, in `src/`)

1. `EnforcerFn` (`src/types.ts`): add an optional 4th arg
   `meta?: { toolCallId?: string }`. Existing adapters call with 3 args →
   unaffected. `enforce()` reads `meta?.toolCallId` and threads it to `logEvent`.
2. `Event` (`src/types.ts`): add optional `callRef?: string` (the toolCallId).
   `logEvent` opts gets `callRef?`; emitted only when present, so every existing
   receipt/hash is byte-identical when no callRef is supplied.
3. `AERFRecord.events[]`: add optional `callRef?`. `JSONLEvent`: add optional
   `callRef?`. All optional → old receipts still parse and verify.
4. `enforce()` signature grows an optional trailing `meta` param, forwarded from
   the enforcer. Default `{}` — `harden()`'s enforcer keeps working unchanged.

## Phased build

- **Phase 1** — `types.ts` (structural interfaces) + rewrite
  `adapters/vercel.ts` to forward `options` and pass `toolCallId` to the
  enforcer; thread `callRef` through `Event`/AERF/JSONL. Tests in
  `adapters/vercel.test.ts`: options forwarding, abortSignal cancels a hanging
  tool, toolCallId lands on the receipt event, no-`execute` tools pass through,
  `harden()` round-trip on a ToolSet still sniffs.
- **Phase 2** — `vercel/index.ts` `withAgentMint()`: one call = one run = one
  receipt. `am.tools(set)` (generic `<T>` preserving type), `am.onStepFinish`
  (capture step/model/usage/finishReason; composable with a user callback),
  `onBlock: "return" | "throw"` (default `return` → `BlockResponse` back to the
  model), `am.receipt()` / `am.writeJSONL()`. Concurrency: two instances share
  nothing (independent `RunState`). Manual-driver tests + one `MockLanguageModelV3`
  `generateText` loop.
- **Phase 3** — `am.toolApproval(policy)` returning the generic
  `VercelToolApproval`; decision comes from `gate()`, appended to the gate hash
  chain and recorded as a run event (`held` → `approved`/`rejected`) before the
  tool event. Policy: `{ tools?; when? }` or spec-driven (`requires_approval` on
  `SpecToolConfig` + `action: block`). Add `requires_approval` to the spec schema
  + parser + tests. `am.recordApproval(decision)` for out-of-band useChat flows.
  Optional HMAC `signature` passthrough behind a capability check.
- **Phase 4** — `examples/vercel-ai-sdk/` (refund agent, MockLanguageModelV3 by
  default, `--live` via AI Gateway strings), README, README integration
  section, CHANGELOG `[0.3.0]`, CLAUDE.md repo-shape line. Full verification +
  `npm pack --dry-run` + `ai`-removed build check.

## Open questions

- **Spec field name** for risky tools: prompt suggests `requires_approval` on
  `SpecToolConfig`. `SpecToolConfig` currently has no such field — Phase 3 adds
  it (boolean) with parser support + tests. `action: block` tools are also
  treated as "requires approval" by the spec-driven policy.
- **AERF wire parity**: `callRef` is additive and optional; need to confirm the
  cross-producer parity test (`test/cross-producer.test.ts`) still passes since
  it checks record shape. It only appears when a toolCallId is present, so
  existing fixtures are unaffected — will verify in Phase 1.
- **`am.onStepFinish` assignability**: keep the name; it is assignable to both
  `onStepFinish` (deprecated) and `onStepEnd`. Example wires `onStepFinish`.

## Out of scope (future Phase 5 sketch)

No `@ai-sdk/workflow` / WorkflowAgent / durable-execution integration. Natural
next step: a `withAgentMint()`-style binding for a `WorkflowAgent` where each
workflow *step* (not just each tool call) emits a receipt event, and the gate
bridge gates step transitions — reusing the same `RunState`/session/receipt
machinery, just driven by the workflow's step lifecycle instead of the tool
loop.
