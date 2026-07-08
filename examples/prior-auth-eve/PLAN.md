# prior-auth-eve — PLAN

Rebuild the prior-auth compliance agent as an **eve** app (`examples/prior-auth-eve/`),
with AgentMint enforcing at the tool boundary and receipting every session.

Verified against **`eve@0.22.0`** (npm `latest`) + `ai` + `zod`, reading
`node_modules/eve/docs/` as ground truth. AgentMint is consumed from the repo
root via `file:../..`.

## Verified eve APIs (from the installed docs)

| Concern | Reality in 0.22.0 | Prompt said | Decision |
|---|---|---|---|
| Tool def | `defineTool({ description, inputSchema, execute(input, ctx) })` from `eve/tools`; **filename = tool name**, `export default` | ✓ matches | as documented |
| Approval | field is **`approval: always()`** from `eve/tools/approval` (`always`/`once`/`never`/policy) | said **`needsApproval`** | use `approval: always()` — flag delta |
| Approval policy | receives `{ session, toolName, toolInput, approvedTools, callId }`; returns AI SDK 7 status (`"approved"`/`"denied"`/`"user-approval"`/`"not-applicable"`/`{type,reason}`) | — | note in code |
| Pause event | **`input.requested`** (carries `requests`), then `session.waiting` | said `authorization.required`/`.completed` | `authorization.*` is **connection OAuth**, NOT tool approval — flag delta |
| Answer approval over HTTP | POST follow-up `{ continuationToken, message: "approve" }` (or `"deny"`); text `approve`/`deny` auto-resolves. Also structured `inputResponses` keyed by requestId | prompt worried this might be TUI-only | **feasible over plain HTTP** — no blocker |
| Per-session state | **`defineState(name, initial)`** from `eve/context` → `{ get(), update() }`, durable, **serializable only** | said `getContext/setContext/ensureContext` | those don't exist; a `RunState` (Maps/Sets/Merkle) is not serializable → **module-level `Map<sessionId, RunState>` with LRU**, exactly the prompt's fallback |
| Session identity | `ctx.session` = `{ id, turn, auth, parent }`; `ctx.callId` = stable tool-call id; `ctx.abortSignal` | ✓ | idempotency key + `callRef` from these |
| Disable defaults | `export default disableTool()` from `eve/tools`, one file per slug; unknown slug fails the build | ✓ | disable bash/read_file/write_file/glob/grep/web_fetch/web_search/todo/ask_question/agent |
| Custom channel | `defineChannel({ routes: [GET(path, h), ...] })` from `eve/channels`; handler `(req, { getSession, params, ... })` | ✓ | `GET /receipt/:sessionId` |
| HTTP session API | `POST /eve/v1/session {message}` → `{sessionId, continuationToken}` + `x-eve-session-id`; `GET /eve/v1/session/:id/stream` (NDJSON); follow-up `POST /eve/v1/session/:id {continuationToken, message}` | ✓ (default port 3000) | as documented |
| CLI | `eve dev --no-ui` (port 3000 / `$PORT`); `.env`/`.env.local` auto-loaded | ✓ | as documented |
| Model | `defineAgent({ model })` accepts a gateway id string **or an AI SDK `LanguageModel`** or **`mockModel(...)` from `eve/evals`** | — | **mockModel** (see below) |

## No model credential in this environment

`AI_GATEWAY_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are all unset here.
A true live provider run is therefore impossible. eve ships **`mockModel`** for
exactly this — "exercise eve's runtime without calling a model provider." It is
part of the agent definition, so `eve dev --no-ui` runs eve's **real** durable
loop, approval, streaming, channels, and receipts against a scripted model:

```ts
model: mockModel({
  modelId: "prior-auth-script", provider: "agentmint-fixtures",
  respond: ({ toolResults }) => /* next {toolCalls:[{name,input}]} | final text */,
})
```

The runtime under test is real; only the model's token generation is scripted —
the same approach the Vercel example uses with `MockLanguageModelV3`. A `--live`
path (gateway model string) is documented in the README for when a key exists.

## AgentMint wiring — the one SDK change

The guard calls `enforce(tool, params, exec, config, state)` (the prompt's
design). Everything else it needs is already on the public surface
(`createRunState`, `logEvent`, `blockResponse`, `buildRecord`, `formatReceipt`,
`formatJSONL`, `loadSpec`, `canonicalize`, types). **`enforce` is not exported.**
It cannot be reached from the app (the built `dist` bundles it into `harden`/
`vercel`, not as its own module), and eve's bundler will not compile the SDK's
raw TS source two directories up.

→ Add a framework-agnostic subpath **`@npmsai/agentmint/enforce`** →
`dist/experimental/enforce.{js,cjs,d.ts}` (tsup entry + `exports` map + a small
test that it imports and enforces). This is generic (the core pipeline), imports
no eve, and touches no existing behaviour. The per-session **run registry** (the
`Map<sessionId, …>` with LRU) stays in the app (`lib/agentmint.ts`), extracted to
the SDK only if a second framework ever needs it.

## The guard (`lib/agentmint.ts`)

`guarded(toolName, execute)` → an eve `execute(input, ctx)` that:

1. **Per-session run**: `getRun(ctx.session.id)` from a module `Map` (LRU cap
   ~100). Each entry = `{ state: createRunState({ spec, evidenceChain: true }),
   config, seen: Map<eventKey, result> }`. On cold-start for a session with an
   existing `receipts/<id>.jsonl`, preload `seen` keys from the file (crash-safe
   dedupe).
2. **Idempotency** (durable-execution requirement): `eventKey =
   sha256(session.id | toolName | canonicalize(input) | session.turn)` (using
   `ctx.callId` as the tie-breaker). If `seen.has(key)`, return the cached result
   — no re-enforce, no duplicate event. This is *the* design point: eve re-runs a
   step interrupted mid-execution, so events must be deduplicable. Documented in
   the guard.
3. **Enforce**: `enforce(toolName, input, () => execute(input, ctx), config,
   state)` — full pipeline (spec cross-refs, blocked tools, breakers). Cross-
   patient protection is the spec's `cross_ref` on `patient_id` (action: block),
   **not** a config-time `bind` — the bound patient isn't known until
   `check_eligibility` runs (README notes this).
4. **On block**: return the structured `BlockResponse` as the tool result (JSON-
   serializable → eve feeds it to the model, which recovers).
5. **submit_determination approval**: eve's `approval: always()` runs BEFORE
   `execute`, so by the time the guard runs approval was granted. Record a
   synthetic `held` + `approved` pair (approver from `ctx.session.auth.current`,
   else `"dev-tui"`) onto the receipt before enforcing — so the receipt tells the
   full story. (eve does not hand the approval record to `execute`; `ctx` exposes
   no decision object — verified. If cross_ref then blocks the cross-patient
   determination, the receipt reads held → approved → blocked: defense in depth.)
6. **Persist**: append each new event to `receipts/<session.id>.jsonl` after the
   call (crash-safe), and keep `state` in memory for the `/receipt` route.

## Target structure

```
agent/
  instructions.md            # workflow order; never a patient other than the
                             # referral's; SUD records are never available
  agent.ts                   # defineAgent({ model: mockModel(...) })
  tools/
    check_eligibility.ts  read_clinical_notes.ts  read_coverage_policy.ts
    match_criteria.ts     read_patient_sud_records.ts   # spec-blocked
    submit_determination.ts                             # approval: always()
    bash.ts glob.ts grep.ts read_file.ts write_file.ts  # disableTool()
    web_fetch.ts web_search.ts todo.ts ask_question.ts agent.ts  # disableTool()
  channels/
    receipt.ts                 # GET /receipt/:sessionId → formatted + JSONL
lib/
  agentmint.ts                 # the guard + per-session run registry
  ehr.ts                       # mock EHR ported from suites/prior-auth.ts
agentmint.spec.yaml            # ported; action:block SUD, requires chains,
                               # cross_ref patient_id action:block
referral.txt                   # the poisoned referral (authored — no prior file)
README.md
```

Note: there is **no** existing `examples/prior-auth/` to port from — the scenario,
spec, and mock EHR live in `src/experimental/suites/prior-auth.ts`. The poisoned
referral text does not exist and will be authored: a referral for PT-4827 that
tries to (a) pull 42 CFR Part 2 SUD records and (b) submit a determination for a
second patient PT-9102.

## Phase 2 attack narrative (scripted mockModel, real runtime)

1. `check_eligibility(PT-4827)` → allowed (binds patient in session store)
2. `read_patient_sud_records(PT-4827)` → **blocked** (action: block) — (a)
3. `read_clinical_notes(PT-4827)`, `read_coverage_policy`, `match_criteria(PT-4827)` → allowed
4. `submit_determination(PT-9102)` → approval parks (`input.requested`); answer
   `approve`; guard records held+approved; `enforce` then **cross_ref-blocks** the
   wrong patient — (b), defense in depth
5. `submit_determination(PT-4827)` → approval parks — (c); answer `approve` →
   held+approved+allowed
Control run: answer `deny` at step 5 → receipt records the rejection.

## Open questions / to verify live in Phase 2

- Exact mount path of custom-channel routes (root vs channel-namespaced) — hit it
  and adjust the README curl.
- `mockModel` tool-call `respond` shape end-to-end (`{ toolCalls: [{ name, input }] }`)
  and whether approval-parked turns re-enter `respond` correctly after resume.
- `ctx.session.auth.current` contents under `localDev` (approver identity string).

## Out of scope (future work, README one-liners only)

No Slack/Discord/Web channels, sandbox customization, schedules, subagents,
connections/MCP, or deployment. `examples/prior-auth` is untouched (it doesn't
exist yet anyway). eve is **not** added to the SDK's deps/devDeps/CI.
