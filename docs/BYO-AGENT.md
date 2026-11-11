# Bring your own agent: ingest API (v1)

Your agent runs in your environment, on your model, and keeps your prompt to itself. The platform
signs, chains, logs and verifies what the agent tells it, so it never sees the prompt or the raw thinking.

```
your agent (any model: LM Studio, Ollama, vLLM, hosted)      platform (filet server)
  ├─ prompt, thinking, tool data  → stays local              ├─ signer (holds issuer key)
  ├─ salted hash of thinking      → POST /v1/.../records  →  ├─ transparency log (authority)
  └─ decision + cited claims      → POST /v1/.../records  →  └─ evidence package for auditors
```

## Auth

`Authorization: Bearer <key>`. Valid keys come from `INGEST_API_KEYS` (comma-separated).
Test bypass: the key `test` is accepted only when `ALLOW_TEST_KEY=1`. That's on by default for `npm start`, and
it should be set to 0 in production. Missing or wrong key → 401 `{ error }`.

## Endpoints (served by `app/server.ts`)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/v1/sessions` | `{ agent, model, prompt_version, prompt_sha256, rules: { [id]: text } }` | 201 `{ session_id, issuer_key_id, issuer_public_key_pem, log_public_key_pem, policy_hash }` |
| POST | `/v1/sessions/:id/records` | one record (below) | 201 `{ receipt_id, seq, receipt_hash }`. Signed on the hot path; anchoring runs in the background. |
| POST | `/v1/sessions/:id/close` | `{}` | 200 evidence package (waits ≤ 10 s for anchoring) |
| GET | `/v1/sessions/:id/package` | | evidence package |

Unknown fields → 400. Any field named `prompt`, `system`, `thinking` or `reasoning_text` anywhere in a body → 400
`{ error: "raw_ip_rejected" }`. This keeps an agent from leaking its own prompt or thinking by mistake. Bodies ≤ 32 KB.

### Records

Every record has `kind`, `turn` (int ≥ 0), `iteration` (int ≥ 1).

| kind | extra fields | receipt `action` |
|---|---|---|
| `model_iteration` | `model, request_id?, stop_reason, usage?: { input_tokens, output_tokens }, reasoning_commitment?: "<64 hex>"` | `model:iteration` (top-level `reasoning_hash` + `commitment_alg: "sha256-salted-v1"` when a commitment is given) |
| `tool_call` | `name, input_sha256, result_sha256, ms` | `tool:<name>` |
| `decision` | `decision_record: { point, decision, rule_id, uncertainty }`, `reasoning: { question, claims: [{ id, text, cites: [{ kind: "rule"\|"tool"\|"turn"\|"claim", ref, value }] }] }` | `decide:<point>` |
| `error` | `error_kind, detail?` | `error:<error_kind>` |

`rule_id` must be one of the session's rules. `reasoning_commitment = sha256(salt + ":" + thinking)` hex, computed
by the agent. The salt and the thinking stay with the agent, which can open the commitment to an auditor later
with `verifyDisclosure` from `src/commitments.ts`.

### Evidence package

Same shape as the live backend's `/call/:id/package`:
`{ call_id, agent, prompt_version, policy_hash, rules: [{id,text}], receipts: [... with log_inclusion_proof], unanchored,
authority: { log_id, public_key_pem, sth }, issuer_public_key_pem, issuer_key_id }`.
Verify with `verifyAerfReceipt(r, { issuerPublicKey, logPublicKey, requireLog: true })` and `verifyAerfChain`.

### Implementation notes (`app/ingest.ts`)

Additive clarifications; the request/response shapes above are unchanged.

- Close signs one last receipt, `close:session`, with `counts` per kind plus `prompt_sha256` and `policy_hash`, so the
  package holds one more receipt than the records posted.
- Errors: unknown `rule_id` → 400 `{ error: "unknown_rule_id", rule_id }`. Unknown session (or one opened with another
  key) → 404. Record after close → 409. Body > 32 KB → 413. `raw_ip_rejected` also carries `field`. Field-name
  matching for raw IP is case-insensitive.
- Canonical JSON carries integers only: `tool_call.ms` is rounded to whole ms, and a fractional cite `value` is stored
  as its decimal string.
- Cite `value` must be a string (≤ 2000 chars), number, boolean or null. Send structured tool fields (objects,
  arrays) as JSON strings.
- Cites: `rule` cites get the session's rule text as `value`, and `claim` cites get the earlier claim's text, no matter
  what the agent sent. An unresolvable ref gets `value: null, resolved: false`. `tool` and `turn` values are stored as sent.
- `policy_hash` = sha256 of canonical `{ agent, prompt_version, rules }`, as on the live backend.

## Local test agent

`agents/local/` holds a healthcare member-line agent that talks to any OpenAI-compatible endpoint:

- LM Studio: `http://localhost:1234/v1`
- Ollama: `http://localhost:11434/v1`
- vLLM

It runs the scenarios in `harness/scenarios/`, extracts reasoning (`reasoning_content`, or `<think>…</think>` in the
text), commits it locally, and posts records to this API. `--model mock` is a scripted model that needs no server.
