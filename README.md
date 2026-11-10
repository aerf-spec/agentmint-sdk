# filet reasoning demo

A mock health-insurance member-line call handled by a voice AI agent, streamed live, showing what
happens on every decision: prompt and raw thinking (vendor-only), tool calls through downstream
services, a structured decision record, Ed25519 signing in an isolated signer process (hot path),
batched anchoring in an RFC 6962 transparency log run by a signing authority (cold path), and
verification. Receipts carry only salted hashes of the prompt, context and thinking.

## Run

```bash
npm install
npm start                         # http://localhost:4173
curl -N "localhost:4173/events?speed=10"
curl -N "localhost:4173/events?speed=4&fail=llm_timeout,tool_error,authority_down,signer_crash"
npm test
npm run loadtest                  # 1,000 receipts at 50/s, then a burst of 1,000
```

## Deploy (Railway)

`railway.json` builds the `Dockerfile` (node:22-slim, runs `node --import tsx app/server.ts`)
with health check `/healthz`. Environment:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 4173 (8080 in Docker) | HTTP port |
| `AUTHORITY_URL` | unset: in-process authority at `/authority` | Authority origin, e.g. `https://filet-authority.anikethsubs.workers.dev` (API under `/authority/v1`) |
| `AUTHORITY_PRIVATE_KEY_PEM` | generated at boot | Log key for the in-process authority |
| `ISSUER_PRIVATE_KEY_PEM` | generated, kept in the signer state dir | Issuer key, handed only to the signer process |
| `SIGNER_STATE_DIR` | `$TMPDIR/filet-signer-state` | Signer WAL + key file (mount a volume to keep chains across deploys) |
| `TRACE_LINK_TEMPLATE` | unset | OTel trace URL template with `{trace_id}` / `{span_id}` |

The production authority only allows GET in CORS preflight: the signer calls it server-side.
