# Examples

Read these in order. Each one builds on the message: every agent action gets a
signed receipt anyone can verify offline. All of them run from a clean clone
with the command shown. Run `npm install` from the repo root first.

## 1. See the deliverable: sample-evidence-packet

For a reviewer, and for any vendor who wants to see what they will hand over
before wiring anything up. A finished evidence packet from a prior auth agent,
verified with one command and no install.

```
npm run example:packet
cd examples/sample-evidence-packet && unzip -o evidence.zip -d packet && node packet/verify.mjs
```

See [sample-evidence-packet/](sample-evidence-packet/). If you received a packet,
start with [FOR-REVIEWERS.md](../FOR-REVIEWERS.md) instead.

## 2. Your first two minutes: quickstart

For the engineer wrapping their first tools. One file. `harden()` in observe
mode records every call and blocks nothing, then prints the receipt box.

```
npm run example:quickstart
```

See [quickstart/](quickstart/).

## 3. Control what gets receipted: spec-gate

For the engineer ready to add rules. It enforces two: a billed amount can never
exceed the authorized amount, and an appeal is held for a clinician. The run
shows one blocked over-bill and one appeal approved, and the chain verifies.

```
npm run example:gate
```

See [spec-gate/](spec-gate/).

## 4. A real framework: vercel-ai-sdk

Reach for this when your tools run on the Vercel AI SDK `generateText` tool
loop. It shows the approval bridge, so a human approves the gated action before
it runs.

```
cd examples/vercel-ai-sdk && echo y | npx tsx run.ts
```

See [vercel-ai-sdk/](vercel-ai-sdk/).

## 5. The full end-to-end reference: prior-auth-eve

Reach for this when you want the complete picture: a durable prior auth agent
on a real framework, processing a poisoned referral, with blocks, a
cross-patient guard, physician approval, and receipts retrievable over HTTP.
This is the most thorough example. Start here only after the first three.

See [prior-auth-eve/](prior-auth-eve/).

## Also here

- [demos/](demos/) : the scenarios behind `agentmint demo`, each runnable on its own.
- [receipt-proof/](receipt-proof/) : a minimal sign-and-verify in a few lines.
- [lm-studio-benchmark/](lm-studio-benchmark/) : a local benchmark of hardened versus baseline agents.
