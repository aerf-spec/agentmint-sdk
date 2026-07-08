# AgentMint × Vercel AI SDK

A refund agent built on the [Vercel AI SDK](https://ai-sdk.dev) `generateText`
tool loop, guarded by AgentMint. One `withAgentMint()` call binds one signed
receipt to the whole run; AgentMint's `gate()` sits behind the AI SDK's
tool-approval flow, so a human approves the refund before it happens.

The agent:

1. looks up order `ORD-1001` (`lookup_order`),
2. issues a refund — which the spec marks `requires_approval: true`, so
   AgentMint's `gate()` asks you to approve it (`issue_refund`),
3. emails the customer a confirmation (`send_email`),

and then writes a JSONL receipt and runs `verify()` over the guardrail spec.

## Run it

No API key needed — the default model is `MockLanguageModelV3`, which scripts
the three-step tool loop locally.

```bash
npm install            # from the repo root (installs ai, zod, tsx)
cd examples/vercel-ai-sdk

npx tsx run.ts         # you'll be prompted to approve the refund (y / n)
echo y | npx tsx run.ts   # auto-approve
echo n | npx tsx run.ts   # deny — the refund never runs, the receipt records it
```

Run against a real model through the [AI Gateway](https://ai-sdk.dev/docs/ai-sdk-core/provider-management#ai-gateway):

```bash
export AI_GATEWAY_API_KEY=...      # your gateway key
npx tsx run.ts --live              # model: openai/gpt-4.1-mini
```

## What it shows

- **`am.tools(tools)`** — wraps the AI SDK `ToolSet`; every tool call is enforced
  and recorded, the ToolSet's TypeScript types are preserved.
- **`am.toolApproval("spec")`** — spec-driven approval. Only `issue_refund`
  (`requires_approval: true`) is gated; the decision is chained onto the gate
  hash chain and the receipt.
- **`am.onStepFinish`** — captures the model id, finish reason, and token usage
  for each step of the loop.
- **`am.writeJSONL(...)`** — an append-only, tamper-evident receipt of the run.
- **`verify(...)`** — an independent, LLM-free pass over the guardrail spec.

## Expected output (approve path)

```
  Refund agent — model: mock

┌────────────────────────────────────────────────────────┐
│  🔒 AgentMint — Approval Required                        │
│  Action:  issue_refund                                  │
│  Context:                                               │
│    order_id: ORD-1001                                   │
│    amount: 42.5                                         │
│  [y] Approve  [n/reason] Reject                         │
└────────────────────────────────────────────────────────┘

  Model said: All done — refund issued and the customer emailed.

╔════════════════════════════════════════════════════════════════╗
║  AgentMint Receipt                                             ║
║  ✓ lookup_order                                                ║
║  ⏸ issue_refund  HELD                                          ║
║    ↳ approval_requested                                        ║
║  ✓ issue_refund  approved                                      ║
║    ↳ gate_approved: by console · gate:67b68cabfc087aa8…        ║
║  ✓ send_email                                                  ║
║  Calls: 3 · Blocked: 0                                         ║
╚════════════════════════════════════════════════════════════════╝

  Step metadata captured from the AI SDK:
    step 0: mock-refund-agent · tool-calls · 144 tokens
    ...

┌────────────────────────────────────────────────────────┐
│  AgentMint Verify — Receipt                            │
│  Scope: 3 files · 3 tools · 0 risky actions            │
│  ✓ 4 claims verified                                   │
│  Recommendation: no action required                    │
└────────────────────────────────────────────────────────┘
```

On the **deny path** (`echo n`), the receipt shows `issue_refund REJECTED` and
`Calls: 2 · Blocked: 1` — the refund's `execute` never ran, and the denial is
recorded with its gate-chain hash.

## Files

| File | What it is |
|---|---|
| `run.ts` | The runnable agent: wiring, mock/live model, receipt + verify output. |
| `tools.ts` | The three tools, defined with the AI SDK's `tool()` + zod. |
| `handlers.ts` | Pure tool handlers, kept separate so `verify()` can read them. |
| `agentmint.spec.yaml` | The guardrail spec (ordering, refund cap, approval, blocklist). |
