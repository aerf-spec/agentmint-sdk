# Reasoning demo: shared contract (v1)

One page streams a mock payer member-benefits phone call and shows, live, what happens under the hood:
conversation → model (prompt, raw thinking, tool call, tool result) → decision record → signer → authority → verified.

Scenario (already scripted in draft-server.ts): James calls Northgate Health's member line about his wife Sarah's
physical therapy. Steps: identity (ID-3), visits remaining with conflicting usage counts (BEN-2), network cost (BEN-5),
request to approve more visits declined + PA request started (PA-0). Agent name `ava-member-line`.

## Endpoints (one Node process, Railway)

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | landing page (`public/index.html`) |
| GET | `/events?speed=1` | SSE stream of one full call run (speed 0.25–10). Each connection = new call. |
| GET | `/authority/v1/key` | `{ log_id, public_key_pem }` |
| POST | `/authority/v1/issuers` | register issuer `{ public_key_pem }` → `{ key_id }` |
| POST | `/authority/v1/batches` | `{ key_id, leaf_hashes: string[], batch_signature }` → `{ proofs: LogInclusionProof[] , sth, sth_signature }` |
| GET | `/authority/v1/sth` | latest `{ sth, sth_signature }` |
| GET | `/authority/v1/consistency?from=&to=` | RFC 6962 consistency proof `{ from, to, proof: string[] }` |
| GET | `/healthz` | `ok` |

`AUTHORITY_URL` env var: if set, the signer talks to a remote authority; otherwise it calls its own `/authority` routes over HTTP (real network boundary, keep-alive agent).

## SSE events (`event:` name, `data:` JSON). Every event has `id:` (monotonic int) for Last-Event-ID resume.

All step-scoped events carry `step` (0-based int, one per agent decision).

| event | data |
|---|---|
| `start` | `{ rules: {id: text}, prompt_version, issuer_key_id, log_id, plan_id }` |
| `turn` | `{ who: "caller"\|"agent", at: "mm:ss", text }` |
| `model_input` | `{ step, at, prompt_version, prompt_sha256, prompt_preview, rules_in_context: string[], transcript_turns }` |
| `thinking` | `{ step, chunk }` (streamed word chunks of raw thinking) |
| `tool_call` | `{ step, name, input }` |
| `tool_result` | `{ step, name, result }` |
| `decision` | `{ step, decision_record }` |
| `signed` | `{ step, seq, receipt_id, receipt_hash, previous_receipt_hash \| null, key_id, signature, sign_us, receipt }` (`receipt` = full signed AERF receipt; `sign_us` = microseconds to sign) |
| `anchored` | `{ step, batch_id, batch_size, leaf_index, tree_size, root_hash, sth_signature, anchor_ms }` (`anchor_ms` = ms from signed to proof received; arrives asynchronously, may come after later steps' events) |
| `verified` | `{ step, issuer: bool, log: "passed"\|"failed", chain_ok: bool }` |
| `done` | `{ chain: {valid, length, rootHash}, receipts, batches, sign_us_p50, sign_us_max, anchor_ms_p50, anchor_ms_max }` |
| `error` | `{ message }` |

Heartbeat: SSE comment `: ping` every 15 s.

## Latency design (hot path vs. cold path)

- Hot path (blocks the agent's next spoken turn): build + Ed25519-sign the receipt only (~tens of µs). Stream `signed` immediately.
- Cold path (never blocks the call): signer queues leaf hashes; every 250 ms (or 64 leaves) it POSTs one batch to the authority,
  signed once by the issuer over `sha256(concat(leaf_hashes))`. Authority appends all leaves to its RFC 6962 log, signs ONE
  STH per batch, and returns one inclusion proof per leaf against that STH. Signer attaches `log_inclusion_proof`
  (post-issuance field, does not change issuer signature or chain), verifies with `verifyAerfReceipt(..., { logPublicKey })`,
  then emits `anchored` and `verified`.
- Authority log: incremental, caches hashes of complete (power-of-two) subtrees so append and proof are O(log n).
- Leaf = `logLeafHash(signedPayloadBytes(receipt))` (same as SDK `attachLogInclusionProof`), so the SDK verifier accepts proofs unchanged.
- Authority sees hashes only: no receipt content, no PHI, no prompt.
- SSE: no buffering, flush per event, ring buffer of last 1000 events for Last-Event-ID resume.

## v1.1 addition: full call-stack instrumentation

The library instruments every layer of the agent automatically, not only decisions:
`instrumentAgent({ llm, tools, downstream })` wraps the model client, the tool map, and downstream service clients
(EHR/claims APIs) and emits nested spans. Agent code is unchanged.

Span kinds (top to bottom of the stack): `turn` → `llm.request` → `llm.response` (thinking, tool_use) →
`tool.dispatch` → `tool.exec` → `downstream.call` (e.g. `claims-api GET /members/NH-552019/benefits`) →
`tool.result` → `decision`.

New SSE event `span`: `{ step, span_id, parent_id | null, kind, name, start_us, dur_us, attrs }`
(`attrs` holds only non-private fields; prompt/thinking appear as sha256). Spans for a step arrive before its `signed`.

Each receipt's `evidence` gains `stack`: `{ trace_id, spans: [{ span_id, parent_id, kind, name, dur_us, attrs_sha256 }] }`,
so the signed receipt commits to the whole call stack of that decision, and every span is clickable on the page.

## v1.2 addition: authority visibility

New SSE events so the page can show the authority working:
- `queued` `{ step, receipt_id, seq, leaf_hash, queue_depth, t_us }`: leaf entered the signer's anchor queue.
- `batch` `{ batch_id, leaf_hashes: string[], seqs: number[], sealed_t_us, sent_t_us, tree_size_before, tree_size_after,
   root_hash, sth: { tree_size, root_hash, timestamp }, sth_signature, authority_ms, delayed: bool, t_us }`: one per batch, after the authority returns.
- `consistency` `{ from_size, to_size, ok, t_us }`: after each batch, the signer checks the new STH is consistent with the previous one.
`anchored` per receipt still follows `batch`.
