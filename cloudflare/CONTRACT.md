# filet demo: shared contract (v2, live backend)

One page streams a payer member-line call and shows, live, what happens under the hood:
conversation → model (thinking summary, tool calls, spans) → decision record → signer → authority → verified.
v1 (recorded / mock replay, `mock-sse.mjs`) events are a subset of v2; everything below is what the live
Cloudflare backend emits.

Scenario: James calls Northgate Health's member line about his wife Sarah's physical therapy (member `NH-552019`).
Identity (ID-3) → visits remaining with a pending claim (BEN-2) → Bayview network cost (BEN-5, NET-1, COST-1)
→ request to approve more visits: declined, provider must request PA, letter offered (PA-0) → close (END-1).
Agent `ava-member-line`, model `claude-opus-5-5` (adaptive thinking, `display: "summarized"`, effort `medium`).

## Deployments

| Worker | URL | Role |
|---|---|---|
| `filet-call` | https://filet-call.anikethsubs.workers.dev | Public API. One Durable Object per call (transcript, chain state, event log, anchor queue). Never holds the issuer key. |
| `filet-signer` | no public route | Holds `ISSUER_PRIVATE_KEY`. Reached only from filet-call via service binding (RPC). Computes `key_id`, `evidence_hash_sha512`, canonical bytes, signature. |
| `filet-authority` | https://filet-authority.anikethsubs.workers.dev | RFC 6962 log of leaf hashes (sees hashes only). filet-call reaches it via service binding. |

CORS (all public routes): `https://filet-demo.pages.dev`, `https://<x>.filet-demo.pages.dev`, `http://localhost:*`,
`http://127.0.0.1:*`. Other origins get no `Access-Control-Allow-Origin`; their preflights and POSTs get 403.

## filet-call endpoints

| Method | Path | Body / auth | Response |
|---|---|---|---|
| POST | `/call[?fail=llm_timeout\|tool_error\|authority_down\|signer_crash]` | none or `{}` | 201 `{ id, events, turn }`. Returns immediately; boot + greeting arrive over SSE. `fail` injects that fault once (labelled `injected: true`). |
| GET | `/call/:id/events` | `Last-Event-ID` header or `?last_event_id=` | SSE. Full replay of the call's event log after the given id, then live. `: ping` every 15 s. `retry: 2000`. |
| POST | `/call/:id/turn` | `{ "text": string }` (≤ 2 KB UTF-8, no control chars, no other fields) | 202 `{ accepted, turn, interrupted? }`. If a turn is running it is interrupted first (barge-in), then the new turn starts. 409 if the call ended or the old turn did not stop in 15 s. |
| POST | `/call/:id/interrupt` (alias `/stop`) | body ignored | 200 `{ stopped: bool, turn?, iteration?, at_ms? }`. Aborts the in-flight Anthropic stream. |
| POST | `/call/:id/end` | none | 200 = the `done` payload. Interrupts a running turn, drains anchoring, reconciles, signs the `close` receipt. |
| GET | `/call/:id/package` | none | Evidence package (below). |
| GET | `/disclose/:receipt_id` | `Authorization: Bearer <DISCLOSE_TOKEN>` | `{ receipt_id, salt, text, commitment_alg }`: opens the salted `reasoning_hash` (thinking summary). 401 without/with a wrong token; 404 if the receipt has no reasoning commitment. Presenter mode only. |
| GET | `/issuer` | none | `{ public_key_pem, key_id, held_by: "filet-signer" }` |
| GET | `/calls/costs` | none | `{ prices_as_of, calls: [{ id, started_at, turns, usd, usd_total, by_model, ended }], total_usd }` (last 100 calls) |
| GET | `/healthz` | none | `ok` |

Errors are JSON `{ error }`: 400 validation (unknown fields rejected), 401, 403 origin, 404, 405, 409, 413 size,
415 content-type, 429 rate limit (with `Retry-After`).
Per-IP limits per minute: calls 5, turns (incl. interrupt) 30, SSE connects 60, end 10, disclose 30, package/costs/issuer 60.
Global: 1,500 turns/day. Per call: 25 turns, 8 model iterations per turn, 8 SSE listeners.

Receipt ids are `<call_id>-r<seq>`.

## SSE events (live)

Every event has an SSE `id:` (monotonic per call), `event:` name, and JSON `data` that always includes `t_us`
(µs since call start; ms resolution). Model-scoped events carry `step` (global 0-based model-iteration index for the call),
`turn` (caller turn number, 0 = greeting) and `iteration` (1-based model call within the turn).

| event | data |
|---|---|
| `start` | `{ call_id, rules: {id: text}, prompt_version, prompt_sha256, policy_hash, issuer_key_id, issuer_public_key_pem, log_id, plan_id, session_id, trace_id, model, effort, key_isolated: true, key_isolation, thinking_kind: "summary", claims_source: "model", fail, anchor_start: { tree_size, root_hash } }` |
| `turn` | `{ who: "caller"\|"agent", at: "mm:ss", text, turn, step?, iteration?, source? }`. `source` on fallback lines: `fallback_after_llm_failure`, `fallback_after_refusal`, `no_reply`. Agent text passed the leak scan. |
| `model_input` | `{ step, turn, iteration, at, prompt_version, prompt_sha256, prompt_preview, rules_in_context: string[], transcript_turns, model, effort, messages }`. `prompt_preview` is a placeholder string; the private prompt never leaves the Worker. |
| `thinking` | `{ step, turn, iteration, chunk, thinking_kind: "summary" }`: summarized thinking, streamed, leak-scanned with a 5-word hold-back. |
| `loop` | `{ step, turn, iteration, stop_reason, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ms, ttfb_ms, request_id, model, tool_uses: string[] }`: one per model iteration; `request_id` from the Anthropic `request-id` response header. |
| `span` | `{ step, turn, iteration, span_id, parent_id, kind, name, start_us, dur_us, attrs, status? }`. Kinds: `turn` (root, emitted at turn end with `step: null`), `llm.request`, `llm.response`, `tool.dispatch`, `tool.exec`, `downstream.call` (`attrs.mock: true`: mock member systems), `tool.result`, `decision`. `status`: `error` / `aborted`. |
| `tool_call` | `{ step, turn, iteration, name, input, tool_use_id }`. `dob` is replaced by `{ hashed }`. |
| `tool_result` | `{ step, turn, iteration, name, result, tool_use_id }` (shapes below) |
| `decision` | `{ step, turn, iteration, decision_record, reasoning, claims, claims_source: "model", rule_text, request_id, tool_use_id }` |
| `signed` | `{ step, turn, iteration, seq, receipt_id, receipt_hash, previous_receipt_hash \| null, key_id, signature, sign_us, hot_us, sign_rpc_ms, signer, receipt }`. `sign_rpc_ms` = measured filet-call→signer round trip; `sign_us`/`hot_us` are measured inside the signer and read 0 (Workers clock does not advance during CPU-only work). |
| `queued` | `{ step, turn, iteration, receipt_id, seq, leaf_hash, queue_depth }` |
| `batch` | `{ batch_id, leaf_hashes, seqs, sealed_t_us, sent_t_us, tree_size_before, tree_size_after, root_hash, sth, sth_signature, authority_ms, rtt_ms, delayed, replayed }`. Flushed every 250 ms or at 64 leaves. |
| `anchored` | `{ step, turn, iteration, seq, receipt_id, batch_id, batch_size, leaf_index, leaf_hash, tree_size, tree_size_before, root_hash, sth, sth_signature, audit_path, log_id, anchor_ms, delayed, log_inclusion_proof }` (`anchor_ms` = signed → proof received) |
| `verified` | `{ step, turn, iteration, seq, receipt_id, issuer: bool, log: "passed"\|"failed", chain_ok: bool, verified_by }`. filet-call's own check: re-canonicalizes the receipt itself (not the signer), verifies the issuer signature, leaf hash, audit path and STH signature. |
| `consistency` | `{ from_size, to_size, ok, sth_signature_ok, proof_len, checked_by: "filet-call" }`: new STH vs the previous STH this call saw (RFC 9162 §2.1.4.2). Runs off the anchoring path, so it can arrive after later `anchored`. |
| `api` | `{ target: "anthropic"\|"signer"\|"authority", method, path, status, ms, request_id?, ttfb_ms?, leaves?, error? }`: every outbound call. `status: 499` = aborted by interrupt. |
| `cost` | `{ step, turn, iteration, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usage, usd, partial?, prices_as_of }`: per model response (`partial: true` for an aborted/failed stream's billed usage). |
| `call_cost` | `{ usd, usd_total, tokens (number), tokens_by_kind, by_model: { model: { usd, requests, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } }, prices_as_of, infra_usd_estimate }` |
| `failure` | `{ failure_id, kind, stage, state, attempt, of, backoff_ms, detail, step, turn, iteration, span_id, injected }` (below) |
| `interrupted` | `{ turn, iteration, step, at_ms, reason: "barge_in"\|"stop", request_id }` (`at_ms` = ms since the turn started; `request_id` = the aborted Anthropic request, if headers arrived). An `interrupted` receipt follows. |
| `reconciled` | `{ reconciled_against: "observed_responses", observed_responses, matched, unmatched_observed: [], unmatched_receipts: [], note }`: request IDs filet-call read from Anthropic response headers vs request IDs in receipts. Not provider-side logs. |
| `done` | `{ chain: { valid, length, rootHash }, receipts, batches, unanchored, sign_us_p50, sign_us_max, anchor_ms_p50, anchor_ms_max, latency: { sign_rpc_ms_p50, sign_rpc_ms_p99, sign_rpc_ms_max, anchor_ms_p50, anchor_ms_p99, anchor_ms_max, sign_us_note }, consistency: { ok, from, to }, usage, cost: { usd_total, by_model, tokens, unpriced_models, prices_as_of, infra_usd_estimate } }` |

Not emitted live: `gap` (sequence numbers are reserved only on a successful sign, so a signer crash leaves no gap), `error`.

### Failures

`kind`: `llm_timeout`, `llm_error`, `tool_error`, `authority_down`, `signer_crash`, `refusal`, `leak_blocked`, `loop_limit`, `agent_error`, `boot_error`.
`stage` → `state`: `detected` / `retrying` / `queued` / `restarted` → `recovering`; `recovered` → `recovered`; `unrecoverable` → `failed`.
One `failure_id` (`f-<n>`) per incident, shared by all its stages.

| kind | stages | receipt |
|---|---|---|
| `llm_timeout` / `llm_error` | detected → retrying (400, 800 ms; of 2) → recovered \| unrecoverable (fallback line spoken) | `error:llm_timeout` / `error:llm_error` per failed attempt (with `request_id` when known) |
| `tool_error` | detected → retrying (300 ms; of 2) → recovered | `error:tool_error` |
| `signer_crash` | detected → restarted (signer session + key_id re-checked) → retrying (200 ms; of 2) → recovered | `error:signer_crash` after the recovered receipt |
| `authority_down` | detected → queued (leaves held; receipts stay signed + chained) → retrying (1, 2, 4, 8, 8 s; of 5) → recovered (`batch of n anchored`) \| unrecoverable (background retry every 30 s) | `error:authority_down` |
| `refusal` | detected → recovered (fallback line) | the iteration receipt has `stop_reason: "refusal"` |
| `leak_blocked` | detected → recovered (text withheld/replaced) | n/a |

Injected faults (`?fail=`): `llm_timeout` = real request with a 1.5 s client deadline; `tool_error` = first tool exec returns a
mock 503; `authority_down` = first 3 flushes not sent; `signer_crash` = a real RPC the signer rejects.

## Receipts (AERF, verify with the SDK unchanged)

Signed by filet-signer: Ed25519 over canonical JSON (JCS, byte-identical to SDK `canonicalBytes`) of the receipt minus
post-issuance fields. Chain: `previous_receipt_hash = sha256(signedPayloadBytes(prev))`, omitted on genesis. Leaf =
`logLeafHash(signedPayloadBytes(receipt))`. `log_inclusion_proof` is attached post-issuance.
Common fields: `id`, `type: "notarised_evidence"`, `plan_id`, `agent`, `action`, `in_policy: true`, `policy_reason`,
`evidence`, `evidence_hash_sha512`, `observed_at`, `aiuc_controls`, `key_id`, `agent_key_id: ""`, `policy_hash`
(sha256 of canonical `{agent, prompt_version, rules}`), `session_id` (= call id), `seq`, `previous_receipt_hash`, `signature`.

| action | when | evidence |
|---|---|---|
| `disclose:ai_and_recording` | greeting (turn 0) | `decision_record` (DISC-0), `claims_source: "scripted"`, `spoken_sha256` |
| `model:iteration` | every model response | `request_id, message_id, model, turn, iteration, stop_reason, usage, tool_uses, thinking_kind: "summary", prompt_version, prompt_sha256, span_id, traceparent`. Top-level `reasoning_hash = sha256(salt + ":" + thinking_summary)` and `commitment_alg: "sha256-salted-v1"` (open with `/disclose`). |
| `decide:<point>` | each `record_decision` | `decision_record, reasoning, claims_source: "model", request_id, model, turn, iteration, tools_this_turn, stack: { trace_id, spans: [{ span_id, parent_id, kind, name, dur_us, attrs_sha256, status? }] }, traceparent, links?` (`links` only when `TRACE_URL_TEMPLATE` is configured) |
| `error:<kind>` | failures above | `error_kind, request_id?, attempt, injected, span_id?, turn, iteration, ...` |
| `interrupted` | barge-in / stop | `turn, iteration, at_ms, reason, request_id, spoken_before_interrupt` |
| `close` | `/end` | `counts: { turns, model_iterations, decisions, errors, receipts, observed_responses, matched }, usage, reconciled_against` |

`decision_record`: `{ schema: "decision-record/v0", point, decision, rule_id, uncertainty, prompt_version, turn, iteration, member: { hashed } }`.

`evidence.reasoning` (lets a client check the reasoning from the receipt alone, without the prompt):

```
{ question: string | { withheld: "leak_scan" },
  claims: [{ id: "c1", text: string | { withheld: "leak_scan" },
             cites: [{ kind: "rule"|"tool"|"turn"|"claim", ref, value, resolved?: false }] }],
  decision, rule_id, uncertainty }
```

Each cite carries the cited value inline: rule text; the tool-result field's value (looked up by key, or by FHIR
extension `url`, newest tool result first; `"tool.key"` form selects a tool); the transcript line
(`"Caller (mm:ss): …"`); or the earlier claim's text. Unresolvable cites have `value: null, resolved: false`.
Claims are model-reported (`claims_source: "model"`) and leak-scanned (fail closed).

Enums (`record_decision`): `point` ∈ identity, dob_verification, visits_remaining, network_cost, approval_request,
consent, escalation, general_info, call_close. `decision` ∈ authorized_rep_found_pending_dob, rep_verified,
rep_not_verified, member_not_found, member_verified, remaining_visits_stated, remaining_visits_flagged,
in_network_cost_stated, out_of_network_costs_stated, declined_provider_must_request_pa, pa_letter_sent,
declined_out_of_scope, sms_consent_recorded, sms_declined, escalated_to_human, info_provided, call_closed.
`uncertainty` ∈ none, pending_claims, out_of_scope, not_verified.

## Rules (public)

DISC-0, ID-3, BEN-2, BEN-5, NET-1, COST-1, PA-0, SMS-1, END-1 (text in `start.rules` and the package).
PA-0: "The agent cannot approve care. Explain that the treating provider must request prior authorization; offer to send a letter explaining how."

## Tools and result shapes (mock member systems)

| tool | input | result |
|---|---|---|
| `check_authorized_rep` | `{ member_id, caller_first_name }` | `{ authorized, relationship, on_file_since, verify_with }` |
| `verify_rep_dob` | `{ member_id, rep_first_name, dob }` | `{ match, method, attempts }` |
| `lookup_benefits` | `{ member_id, benefit, year }` | FHIR R4 `CoverageEligibilityResponse`: `insurance[0].item[0].benefit[]` with `{ type: benefit-type "visit", allowedUnsignedInt: 20, usedUnsignedInt: 17 }` and `{ type: "copay", allowedMoney }`; `item.description` and `disposition` carry the claims lag (1 visit pending adjudication, not in `usedUnsignedInt`). |
| `check_network` | `{ member_id, provider }` | `{ provider, in_network, member_cost_out_of_network, member_cost_in_network, estimate_basis, in_network_alternatives }` |
| `check_prior_auth` | `{ member_id, benefit, requested_visits }` | Da Vinci CRD `ext-coverage-information`: `{ url, extension: [coverage, covered ("covered"\|"conditional"\|"not-covered"), pa-needed ("auth-needed"\|"no-auth"\|"conditional"), doc-needed?, billingCode (CPT 97110), reason, date, coverage-assertion-id] }` |
| `send_pa_letter` | `{ member_id, delivery: "mail"\|"portal" }` | `{ letter_id, template, delivery, expected }` |
| `record_decision` | `{ question, point, decision, rule_id, uncertainty, claims[] }` | `{ recorded, receipt_id, seq }` (signs the decision receipt) |

PHI-returning tools refuse with `{ error: "caller_not_verified", rule: "ID-3" }` until `verify_rep_dob` matched.

## Evidence package: `GET /call/:id/package`

```
{ call_id, started_at, ended_at, agent, prompt_version, policy_hash,
  rules: [{ id, text }], transcript: [{ at, who, text }],
  receipts: [full signed receipts, each with log_inclusion_proof once anchored], unanchored,
  authority: { origin, log_id, public_key_pem, sth: { sth, sth_signature } },
  issuer_public_key_pem, issuer_key_id, cost, verify }
```

No prompt, no thinking text. Verify with the SDK:
`verifyAerfReceipt(r, { issuerPublicKey: issuer_public_key_pem, logPublicKey: authority.public_key_pem, requireLog: true })`
and `verifyAerfChain(receipts, { issuerPublicKey })`.

## Cost

Prices (USD / 1M tokens, `prices_as_of: 2026-11-10`): claude-opus-5-5 input 4.00, output 20.00, cache read 0.20,
cache write 5.00; claude-haiku-5-5 input 0.10, output 0.50, cache read 0.01, cache write 0.125.
`infra_usd_estimate` = Workers requests × $0.30/M + DO requests × $0.15/M (CPU/duration excluded).

## Authority API (`/authority/v1`, see authority-worker/README.md)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/key` | | `{ log_id, public_key_pem, key_id }` |
| POST | `/issuers` | `{ public_key_pem }` + `Authorization: Bearer <REGISTRATION_TOKEN>` | `{ key_id }` |
| POST | `/batches` | `{ key_id, leaf_hashes[] (≤ 1024), batch_signature, batch_ts }` | `{ proofs[], sth, sth_signature, tree_size_before, tree_size_after, authority_ms, replayed? }` |
| GET | `/sth` | | `{ sth, sth_signature }` |
| GET | `/consistency?from=&to=` | | `{ from, to, proof[] }` |

`batch_signature` = issuer Ed25519 over `SHA-256(concat(raw leaf hashes) || utf8(batch_ts))`; `batch_ts` must be within
±5 min. The same leaf set is never appended twice (`replayed: true` with the original proofs). Unknown fields → 400.
Per-IP limits/min: reads 300, issuers 10, batches 1200.

## Latency design

- Hot path (blocks the agent's next turn): one service-binding RPC to filet-signer (measured p50 ≈ 20 ms), then `signed`.
- Cold path: leaves queue in the call DO; flush every 250 ms or 64 leaves; one signed batch → one STH → per-leaf proofs
  → `batch`, `anchored`, `verified`; the consistency check runs on its own chain after that.
