# AgentMint x Vercel AI SDK

Reach for this example when you are integrating AgentMint with the
[Vercel AI SDK](https://ai-sdk.dev) `generateText` tool loop.

A prior-auth agent built on the Vercel AI SDK `generateText` tool loop, guarded
by AgentMint. One `withAgentMint()` call binds one signed receipt to the whole
run. AgentMint's `gate()` sits behind the AI SDK's tool-approval flow, so a
human approves the prior auth before it happens. Every agent action gets a
signed receipt. Anyone can verify the chain, offline, without trusting the
agent, the app, or us.

The agent:

1. looks up authorization `PA-2210` (`lookup_auth`),
2. submits a prior auth, which the spec marks `requires_approval: true`, so
   AgentMint's `gate()` asks you to approve it (`submit_prior_auth`),
3. notifies the payer with a confirmation (`notify_payer`),

and then writes a JSONL receipt and runs `verify()` over the guardrail spec.

## Run it

No API key needed. The default model is `MockLanguageModelV3`, which scripts
the three-step tool loop locally.

```bash
npm install            # from the repo root (installs ai, zod, tsx)
cd examples/vercel-ai-sdk

npx tsx run.ts         # you'll be prompted to approve the prior auth (y / n)
echo y | npx tsx run.ts   # auto-approve
echo n | npx tsx run.ts   # deny. The prior auth never runs, the receipt records it
```

Run against a real model through the [AI Gateway](https://ai-sdk.dev/docs/ai-sdk-core/provider-management#ai-gateway):

```bash
export AI_GATEWAY_API_KEY=...      # your gateway key
npx tsx run.ts --live              # model: openai/gpt-4.1-mini
```

## What it shows

- **`am.tools(tools)`**: wraps the AI SDK `ToolSet`. Every tool call is enforced
  and recorded, and the ToolSet's TypeScript types are preserved.
- **`am.toolApproval("spec")`**: spec-driven approval. Only `submit_prior_auth`
  (`requires_approval: true`) is gated. The decision is chained onto the gate
  hash chain and the receipt.
- **`am.onStepFinish`**: captures the model id, finish reason, and token usage
  for each step of the loop.
- **`am.writeJSONL(...)`**: an append-only, tamper-evident receipt of the run.
- **`verify(...)`**: an independent, LLM-free pass over the guardrail spec.

## Expected output (approve path)

```
  Prior-auth agent. Model: mock
  When the agent tries to submit the prior auth, AgentMint's gate
  will ask you to approve it (type y / n at the prompt).


┌────────────────────────────────────────────────────────┐
│  🔒 AgentMint - Approval Required                       │
│                                                        │
│  Action:  submit_prior_auth                            │
│  Context:                                              │
│    auth_id: PA-2210                                    │
│    billed_amount: 42.5                                 │
│                                                        │
│  Auto-deny in 5:00                                     │
│                                                        │
│  [y] Approve  [n/reason] Reject                        │
└────────────────────────────────────────────────────────┘


  Model said: All done. Prior auth submitted and the payer notified.

╔════════════════════════════════════════════════════════════════╗
║  AgentMint Receipt                                             ║
║  Run: amr_v4kanlrv                                             ║
╠════════════════════════════════════════════════════════════════╣
║  ✓ lookup_auth                                                 ║
║  ⏸ submit_prior_auth  HELD                                     ║
║    ↳ approval_requested                                        ║
║  ✓ submit_prior_auth  approved                                 ║
║    ↳ gate_approved: by console · gate:b27824d8e5e3edd0…        ║
║  ✓ notify_payer                                                ║
║                                                                ║
║  Calls: 3 · Blocked: 0                                         ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝

  Receipt written to /home/user/agentmint-sdk/examples/vercel-ai-sdk/receipts/run.jsonl

  Step metadata captured from the AI SDK:
    step 0: mock-prior-auth-agent · tool-calls · 144 tokens
    step 1: mock-prior-auth-agent · tool-calls · 144 tokens
    step 2: mock-prior-auth-agent · tool-calls · 144 tokens
    step 3: mock-prior-auth-agent · stop · 144 tokens

┌────────────────────────────────────────────────────────┐
│  AgentMint Verify - Receipt                            │
│                                                        │
│  Scope: 3 files · 3 tools · 0 risky actions            │
│                                                        │
│  ✓ 4 claims verified                                   │
│                                                        │
│  Recommendation: no action required                    │
│  Hash: 29829939833d…                                   │
└────────────────────────────────────────────────────────┘
```

On the **deny path** (`echo n`), the receipt shows `submit_prior_auth REJECTED`
and `Calls: 2 · Blocked: 1`. The prior auth's `execute` never ran, and the
denial is recorded with its gate-chain hash.

## Files

| File | What it is |
|---|---|
| `run.ts` | The runnable agent: wiring, mock/live model, receipt plus verify output. |
| `tools.ts` | The three tools, defined with the AI SDK's `tool()` plus zod. |
| `handlers.ts` | Pure tool handlers, kept separate so `verify()` can read them. |
| `agentmint.spec.yaml` | The guardrail spec (ordering, billed amount cap, approval, blocklist). |
