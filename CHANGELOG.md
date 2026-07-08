# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- **Breaking (minor, 0.x):** the plan-bound AERF layer moved off the package
  root to the `@npmsai/agentmint/notary` subpath, so the root exports only the
  wedge (harden → signed receipt → verify). `Notary`, `FileReceiptSink`,
  `buildPlan`/`signPlan`/`verifyPlan`/`evaluatePolicy`, `buildAerfReceipt`/
  `verifyAerfReceipt`, `EvidencePackage`, and the other plan/AERF/evidence
  symbols are no longer at the root. Migration:

  ```diff
  - import { Notary, buildPlan } from "@npmsai/agentmint";
  + import { Notary, buildPlan } from "@npmsai/agentmint/notary";
  ```

  `harden`, `loadSpec`, `verify`, `gate`, the signed decision receipts
  (`verifyDecisionReceipts`), and chain verification stay at the root.
- **New:** `@npmsai/agentmint/enforce` subpath — the core enforcement pipeline
  (`enforce`) exposed as a framework-agnostic primitive, so an integration can
  drive one `RunState` per session by hand (`createRunState` + `enforce`).
- **New:** `examples/prior-auth-eve/` — a prior-auth compliance agent on Vercel
  **eve** (durable agents), with AgentMint enforcing inside each eve tool and one
  hash-chained receipt per session, retrievable over HTTP. Demonstrates the
  durable-execution design AgentMint needs there: enforcement state persisted in
  eve's `defineState` and rehydrated per step, idempotent event keys for step
  replay, eve's native `approval` recorded on the receipt (grants and denials),
  and the default harness disabled. eve is not a dependency of the SDK.

## [0.3.0]

- **New:** first-class Vercel AI SDK integration, exposed as the
  `@npmsai/agentmint/vercel` subpath. `withAgentMint()` binds one signed receipt
  to one `generateText` / `streamText` / Agent run (including multi-step tool
  loops): `am.tools()` wraps a `ToolSet` while preserving its TypeScript types,
  `am.onStepFinish` captures per-step model id / token usage / finish reason, and
  `am.receipt()` / `am.writeJSONL()` emit one record for the whole run.
- **New:** `am.toolApproval(policy)` bridges AgentMint's hash-chained `gate()`
  into the AI SDK's tool-approval flow. Policies are spec-driven (tools marked
  `action: block` or `requires_approval: true`) or explicit (`{ tools, when }`);
  every decision is chained onto the gate hash chain and recorded on the receipt.
  `am.recordApproval()` chains out-of-band (`useChat`) decisions.
- **New:** `requires_approval` field on a tool in `agentmint.spec.yaml`.
- **Fix:** the Vercel adapter now forwards the AI SDK's `execute(input, options)`
  second argument to the wrapped tool. The previous adapter dropped it, silently
  breaking `abortSignal` cancellation and discarding `toolCallId` / `messages`.
  This is user-visible behaviour: tools can now be cancelled, and each receipt
  event carries the originating `toolCallId` as `callRef`.
- `ai` and `zod` added as devDependencies (types, tests, and the example only);
  `dependencies` stays empty — shipped runtime code uses structural typing and
  never imports `ai`.

## [0.2.0]

- **New:** `agentmint verify` — independent, deterministic verification of a git
  diff or directory. It derives invariants from the spec, type definitions, and
  PR/ticket context, runs checks with no LLM in the decision loop, and emits a
  verification receipt (terminal box, JSON, or JSONL) with a SHA-256 hash.
- **Fix:** a bare `action: block` / `action: warn` on a tool with no concrete
  rules now blocks/warns the tool unconditionally instead of being a no-op.
- **Fix:** `blocked_patterns` (and `blocked_values`) now support glob matching —
  `*@competitor.com` matches `ceo@competitor.com`, while plain substrings stay
  backward compatible.
- **New:** `agentmint test --suite <prior-auth|coding-agent|refund-agent>` runs
  pre-built behavioural suites (28 scenarios) with `--json` and `--list`.
- **New:** `agentmint learn --from <path>` infers a spec from past violation
  receipts, with `--out` and `--merge`.
- Package renamed to `@npmsai/agentmint`; zero runtime dependencies.
- `openai` moved to `devDependencies` — it is only used for structural typing
  in the OpenAI adapter and is not imported at runtime.
- The CLI now reads its version from `package.json` instead of a hardcoded
  string, so `agentmint version` always matches the installed release.
- Added `LICENSE` to the published `files` array so the MIT license ships in
  the tarball.

## [0.1.1]

- Maintenance release.

## [0.1.0]

- Initial public release: validation, circuit breakers, and audit receipts for
  AI agent tool calls, with a CLI (`demo`, `init`, `watch`, `ci`, `diff`) and
  ESM/CJS builds.

[0.2.0]: https://github.com/aerf-spec/agentmint-app/releases/tag/v0.2.0
[0.1.1]: https://github.com/aerf-spec/agentmint-app/releases/tag/v0.1.1
[0.1.0]: https://github.com/aerf-spec/agentmint-app/releases/tag/v0.1.0
