# filet reasoning demo

A mock health-insurance member-line call handled by a voice AI agent, streamed live. For every
decision the page shows what happens under the hood:

- **Vendor-only:** the prompt, the raw thinking, tool calls and the downstream service calls they make.
- **Hot path:** a structured decision record, signed with Ed25519 in an isolated signer process.
- **Cold path:** the receipt is batched into an RFC 6962 transparency log run by a signing authority.
- **Verification:** each receipt is checked against the issuer key, the log key and the chain.

Receipts never contain the prompt or the thinking. They carry only salted commitments to them.

## Run

```bash
npm install
npm start                         # http://localhost:4173
curl -N "localhost:4173/events?speed=10"
curl -N "localhost:4173/events?speed=4&fail=llm_timeout,tool_error,authority_down,signer_crash"
npm test
npm run loadtest                  # 1,000 receipts at 50/s, then a burst of 1,000
```

Routes: `/` (page), `/events` (SSE, one scripted call per connection, `Last-Event-ID` resume),
`/disclose/:receipt_id` (vendor-side opening of a receipt's commitments, demo only),
`/authority/v1/*` (local authority when `AUTHORITY_URL` is unset), `/healthz`.

## Deploy (Railway)

`railway.json` builds the `Dockerfile` (node:22-slim). The container runs `node --import tsx app/server.ts`
and Railway health-checks `/healthz`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 4173 (8080 in Docker) | HTTP port |
| `AUTHORITY_URL` | unset: in-process authority at `/authority` | Authority origin, e.g. `https://filet-authority.anikethsubs.workers.dev` (API under `/authority/v1`) |
| `AUTHORITY_TOKEN` | unset | Bearer token sent by the signer, for authorities that require it on writes |
| `AUTHORITY_PRIVATE_KEY_PEM` | generated at boot | Log key for the in-process authority |
| `ISSUER_PRIVATE_KEY_PEM` | generated, kept in the signer state dir | Issuer key, handed only to the signer process |
| `SIGNER_STATE_DIR` | `$TMPDIR/filet-signer-state` | Signer WAL + key file (mount a volume to keep chains across deploys) |
| `TRACE_LINK_TEMPLATE` | unset | OTel trace URL template with `{trace_id}` / `{span_id}` |

The production authority's CORS preflight allows only GET. The signer calls it server-side;
the browser never does.

## How it fits together

| File | Role |
|---|---|
| `app/trace.ts` | Instrumentation. Plain async functions, no framework imports: `traceLLM(client, { method, map })`, `traceTools(map)`, `traceDownstream(name, client)`, `decision(record, spec)` and `@traced(kind)`. Ships `anthropicMap`, `openaiMap` and `genericMap`. |
| `app/scenario.ts` | The ten-decision call. The agent is plain code: it is wrapped once in `buildAgent()`, and its only tracing call is `decision(...)`. |
| `app/signer-proc.ts` | The only process that holds the issuer key. It keeps chain state and an append-only WAL, serves length-prefixed JSON frames over a unix socket, and batches anchoring (every 250 ms or 64 leaves, one issuer signature per batch). |
| `app/signer.ts` | Agent-side client. Supervises and restarts the signer, pipelines requests, and re-sends idempotently after a crash. |
| `app/authority.ts`, `app/log.ts` | Local authority. Incremental RFC 6962 log with cached subtrees, one signed tree head (STH) per batch, inclusion and consistency proofs. |
| `app/call.ts` | One call end to end. Emits every SSE event and checks completeness (close receipt, seq gaps, provider reconciliation). |
| `src/` | Trimmed SDK core: receipts, chain, plans, Merkle, salted commitments, trace links. |

What each receipt's `evidence` holds:

- `decision_record`: enums and identifiers only. `member_id` is a salted hash.
- `claims_sha256` and `claim_cites`: the structure of the reasoning, without its text.
- `stack`: every span of the step with a salted `attrs_sha256`. Routes are templated (`/members/:id/...`).
- `llm_request_ids`, a W3C `traceparent`, and trace `links`.

`reasoning_hash` and `context_hash_sha256` are `sha256(salt:text)`, marked `commitment_alg: "sha256-salted-v1"`.

### Trace-link URL shapes

- **Langfuse:** `{host}/project/{project}/traces/{trace_id}`. The documented shape.
- **OpenAI:** `platform.openai.com/traces/trace?trace_id=trace_{trace_id}`.
- **LangSmith:** the default keys the run by the W3C trace id formatted as a UUID.
- **Others:** Jaeger, Honeycomb, Grafana Tempo and Datadog have no reliable default URL. Pass your own template with `otel({ urlTemplate })`.

The OpenAI and LangSmith shapes may be wrong for your setup. Override them with `urlTemplate` if they don't match.

## Measured latency (4-vCPU sandbox VM, local authority)

| Load | Hot path (agent → signed receipt, incl. IPC) | In-signer `sign_us` | Anchor (signed → proof) | Loss |
|---|---|---|---|---|
| 1,000 at 50/s | p50 ~0.6–0.7 ms, p99 0.9–1.8 ms | p50 ~250 µs, p99 ~420 µs | p50 ~130 ms, p99 ~250 ms | 0 |
| burst of 1,000 | queueing-bound (~1 s for all 1,000) | p50 ~110–230 µs | p99 ~0.6 s | 0 |

An idle round trip over the unix socket costs about 350 µs (p50) on this VM. That wake-up jitter is
most of the p99. The signer's own work is about 0.25 ms.

Inside the demo server the hot path also covers the agent side's own work: building the evidence,
the salted commitments, the leak scan and the stack snapshot. The server is busy streaming SSE at
the same time. At `speed=10` the measured hot path is p50 about 1.3 ms, max about 2 ms per call.
The `done` event reports these numbers for every call.

## Authority protocol notes

The production authority needs two things the original contract did not have:

- **Bearer token:** `POST /v1/issuers` requires `AUTHORITY_TOKEN`.
- **Timestamped batches:** each batch carries `batch_ts`, an ISO-8601 UTC time within ±5 min of the
  authority's clock. The issuer signs `sha256(concat(leaf hashes) || utf8(batch_ts))`.

The signer always sends `batch_ts`, re-signing on every retry. The local authority accepts batches
with or without it.
