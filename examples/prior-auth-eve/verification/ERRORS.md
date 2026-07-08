# Live-verification error log (Phase 2)

Every error hit while bringing the agent up under a real `eve dev --no-ui`
server, its root cause, and the fix. All are resolved; the app boots, both the
approve and deny paths run over HTTP, and the receipts verify (see the
`transcript-*.ndjson` and `receipt-*.{json,jsonl,txt}` artifacts here). This
doubles as the "log the delta vs the task notes" the PLAN asked for.

| # | Symptom | Root cause | Fix |
|---|---------|-----------|-----|
| 1 | `eve requires Node.js >=24. You are running v22.22.2` | The environment's default Node is 22; eve needs ≥24. | Installed Node 24 via `nvm install 24`. All eve commands run under Node 24. |
| 2 | `Cannot compile agent compaction because the primary compaction trigger model "…" does not have known AI Gateway context window metadata` | eve's compaction needs a model context-window size at build time. A `mockModel` (and, offline, even real gateway ids like `anthropic/claude-sonnet-5`) has none in this environment. | Set the top-level `defineAgent({ modelContextWindowTokens: 200_000 })` escape hatch, which supplies the window verbatim and skips the gateway lookup. (A model *selection object* is only valid from a dynamic resolver, not at the top level — that intermediate attempt failed with "provide a valid AI SDK language model".) |
| 3 | `agent/tools/agent.ts exports disableTool() but "agent" is not a framework tool` | `disableTool()` only accepts real default-harness slugs; `agent` (the subagent tool) isn't one. | Removed `agent/tools/agent.ts`. The valid disable slugs are `ask_question, bash, glob, grep, load_skill, read_file, todo, web_fetch, web_search, write_file` — the nine shell/file/web/todo/ask_question defaults are disabled. |
| 4 | `Failed to bundle authored module "…/tools/check_eligibility.ts". Expected one bundled authored module` | `@npmsai/agentmint` was installed as a **symlink** (`file:../..`) pointing at the repo root — which *contains* this example. eve's bundler followed the self-referential symlink into a cycle. | Added `.npmrc` with `install-links=true` so npm **copies** the dependency (dist only) into `node_modules` instead of symlinking. No cycle; `npmsai__agentmint.mjs` bundles cleanly. |
| 5 | `ENOENT: … node_modules/.cache/agentmint.spec.yaml` at build | eve bundles authored code and runs it from `node_modules/.cache`, so an `import.meta.url`-relative path to the spec missed the app's files. | Resolve the spec and receipts dir from `process.cwd()` — the app root under `eve dev`/`build`/`start` and vitest. |
| 6 | **The important one.** `read_clinical_notes`, `match_criteria`, and the legitimate `submit_determination` were all `blocked` with reason `requires` ("check_eligibility must be called before …"), even though `check_eligibility` had run. | eve runs each tool call as an **isolated durable step**. Module-level memory does not survive across steps, so the per-session `RunState` held in a process `Map` was empty on every call — `completedSteps` and the session store were lost, so `requires`/`cross_ref`/breakers wrongly fired. The prompt's assumed "module-`Map` fallback" cannot work across eve's step isolation. | Persist a **serializable snapshot** of the enforcement state in eve's `defineState` (durable, session-scoped, survives step boundaries and crashes). Rehydrate a `RunState` from it before each `enforce`, rebuild the Merkle evidence chain from the recorded events, and write the updated snapshot back after. A module-`Map` fallback is kept only for non-eve unit tests. This is now the example's central lesson. |
| 7 | `GET /receipt/:sessionId` returned `receipt: null` / empty box even though tools had run | The channel route runs in the Nitro HTTP context, **separate** from the durable tool steps, so it sees none of their in-process state. | The guard writes the receipt to files after every call — `<id>.jsonl` (append-only), `<id>.receipt.json` (AERF record incl. evidence root), `<id>.receipt.txt` (rendered box) — and the route reads those files. Crash-safe and cross-context. |
| 8 | On the deny control, the receipt did **not** record the rejection | eve runs `execute` only when an approval is **granted**; a denied determination never reaches the guard, so nothing recorded it. | Added `agent/hooks/approval-audit.ts`: an `input.requested` handler stashes each pending approval's tool+input, and an `action.result` handler detects `TOOL_EXECUTION_DENIED` and records a `held → rejected` pair. The deny path now reads `held → approved → blocked(PT-9102) → held → rejected(PT-4827)`. |
| 9 | `tsc` error: `Conversion of type … 'readonly …' … may be a mistake` in the hook | eve types stream-event payloads as `readonly`; my narrower cast didn't overlap. | Cast the event data through `unknown` before narrowing. Runtime was unaffected (eve's own build is not strict-typed); this only satisfies the app's `tsc --noEmit`. |

## Deltas vs the task notes (docs won)

- **`approval: always()`**, not `needsApproval` (per-tool approval field).
- Tool-approval pause is **`input.requested`** + answered by a follow-up message
  `approve`/`deny`; **`authorization.required/completed`** is connection OAuth,
  unrelated to tool approval.
- `eve/context` exposes **`defineState`** (serializable durable slots), not
  `getContext`/`setContext`/`ensureContext`. This is what actually solved the
  cross-step state problem — the prompt's module-`Map` fallback is insufficient
  under eve's step isolation.
- Helper code lives under **`agent/lib/`** (eve's documented layout), not the
  app root.
- No AI credential in this environment → the agent's model is eve's own
  **`mockModel`**, scripting the attack while eve's real durable runtime
  (approval, streaming, channels, receipts) runs underneath.

## Verified end-to-end (no credential, real eve runtime)

- **Approve path** — `allowed → blocked(SUD action_block) → allowed → allowed →
  allowed → held → approved → blocked(cross_ref PT-9102) → held → approved →
  allowed(PT-4827)`. Summary: 7 calls, 5 executed, 2 blocked, 2 held, evidence
  root present.
- **Deny path** — same head, ending `held → approved → blocked(PT-9102) → held →
  rejected(PT-4827)`. Summary: 6 calls, 4 executed, 3 blocked, 2 held.
