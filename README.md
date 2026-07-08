# agentmint

Cryptographic receipts for AI agent actions. Wrap a tool call, get a signed,
hash-chained receipt; an auditor verifies it later — offline, with no
agentmint code and no trust in the agent, the app, or us.

Zero runtime dependencies (`node:crypto` only). Dual ESM/CJS. Node ≥ 18. MIT.
Install with `npm install @npmsai/agentmint`.

## The problem

Agents act — they call tools, move money, touch records — and the record of
what they did is usually a mutable log line the same process could rewrite or
quietly drop. That gap is now a named one: the EU AI Act requires high-risk
systems to keep tamper-evident event records ([Article 12](https://artificialintelligenceact.eu/article/12/)),
the [OWASP GenAI Security Project](https://genai.owasp.org/) lists
repudiation and untraceable agent actions among its core agentic threats, and
audit frameworks (SOC 2, AIUC-1) increasingly ask for evidence that a control
*ran*, not a claim that it exists.

agentmint applies old, boring primitives — Ed25519 signatures, hash chains, and
RFC 6962 Merkle trees — at the tool boundary, implementing the [AERF receipt
format](https://github.com/aerf-spec/aerf) so receipts verify across independent
implementations (this SDK, a Python producer, a Go verifier).

We won't oversell it: a receipt proves what was observed and signed, not what
*should* have happened. If every signer sees the same poisoned input, they all
sign it honestly. What receipts make impossible is silent revision: a changed
field breaks a signature, and a deleted receipt breaks the hash chain *and* the
sequence numbers.

## Start here — one line, zero config

No spec, no keys, no setup: every call is recorded and you get a receipt.

```ts
import { harden } from "@npmsai/agentmint";

const tools = harden(myTools);          // observe-and-receipt mode
await tools.charge_card({ amount: 4000 });
console.log(tools.__receipt());         // a rendered receipt box for the run
```

Run it now — `npm run demo:tamper` signs a five-decision run, flips one byte, and
shows the chain catch it (real signed output, no install).

## Add a spec — turn observation into a guardrail

A spec makes calls *fail* on a rule. The signature rule, `max_ref`, bounds an argument by a prior tool's output — so a refund can't exceed the order:

```ts
import { harden, loadSpec } from "@npmsai/agentmint";

const tools = harden({ lookup_order: async () => ({ total: 40 }), refund }, {
  spec: loadSpec(`
version: "1.0"
tools:
  refund:
    input:
      properties:
        amount:
          max_ref: "lookup_order.output.total"
          action: block
`),
});
await tools.lookup_order({ order_id: "ord_1" });
await tools.refund({ amount: 500 }); // blocked: 500 > 40 — refund never runs
```

## Learn the spec from receipts

When a run trips a rule, its receipts become the policy: `learn` infers spec YAML from past violations and generates a hermetic regression test that flags any later edit reopening a caught hole.

```
$ agentmint learn --from receipts/incident.jsonl --out policy.yaml --test policy.test.ts
$ agentmint learn --from receipts/ --check edited.yaml   # exit 1 if an edit reopened a hole
```

## Sign — receipts nobody can revise

Pass a key and every decision emits an Ed25519-signed, hash-chained receipt; `__verifyReceipts()` checks signatures, hash links, and sequence numbers.

```ts
import { generateKeyPairSync } from "node:crypto";
const privateKeyPem = generateKeyPairSync("ed25519").privateKey
  .export({ type: "pkcs8", format: "pem" }) as string;

const tools = harden(myTools, { signing: { privateKeyPem } });
await tools.send_email({ to: "ops@example.com" });
tools.__verifyReceipts(); // { ok: true } — or the exact break index and why
```

## Export — hand an auditor a self-verifying bundle

`agentmint export` bundles receipts, the signed plan, and a Merkle root into a zip with a standalone Node verifier — no agentmint, no network:

```
$ agentmint export --from receipts/ --out evidence.zip --plan plan.json --key notary_key.pem
$ unzip evidence.zip && node verify.mjs   # standalone: plan sig, receipt sigs, chain, root
```

For plan-bound AERF evidence directly (signed plans, chained receipts that
survive restarts, cross-implementation verification), use the `Notary` on the
[`@npmsai/agentmint/notary`](docs/cookbook.md) subpath.

## Cookbook

Every recipe runs as written — full versions in [`docs/cookbook.md`](docs/cookbook.md).

| Recipe | The line that matters |
|---|---|
| Block a tool | `drop_table: { action: block }` |
| Require B before A | `issue_refund: { requires: [lookup_order] }` |
| Loop breaker | `breakers: { loop: { max_identical_calls: 3 } }` |
| Per-run budget cap | `harden(tools, { budget: 5, costEstimator })` |
| Shadow mode (record, don't block) | `harden(tools, { mode: "shadow" })` |

## Framework integrations

For the Vercel AI SDK, `withAgentMint()` binds one signed receipt to a `generateText` run and puts `gate()` behind the SDK's tool-approval flow.

```ts
import { withAgentMint } from "@npmsai/agentmint/vercel";
const am = withAgentMint({ spec: "agentmint.spec.yaml" });
const result = await generateText({ model, tools: am.tools(myTools), onStepFinish: am.onStepFinish });
am.writeJSONL("./receipts/run.jsonl"); // one AERFRecord for the whole run
```

`harden()` already wraps raw, OpenAI, Anthropic, and LangChain shapes. Runnable examples: [Vercel AI SDK](examples/vercel-ai-sdk/) · [eve durable agents](examples/prior-auth-eve/).

## Verify it yourself

```
$ node test/aerf-verify-poc.mjs   # 12/12 AERF conformance vectors
$ npx vitest run                  # full suite, incl. cross-producer byte-match vs the Python reference
$ npm run demo:trace              # control vs hardened run, gate internals
```

The three proof layers — per-run Merkle evidence, per-decision signed receipts, and plan-bound AERF notary receipts — and what the receipts do and don't defend against are in [`THREAT-MODEL.md`](THREAT-MODEL.md#proof-layers); [`docs/parity.md`](docs/parity.md) has the wire-format guarantees.

## Contributing

Honest bar: the oracle stays 12/12 and `npx vitest run` stays green, or the
change doesn't land. Bugs — open an issue with a receipt or vector that
reproduces it. Wire-format changes belong in the
[AERF spec](https://github.com/aerf-spec/aerf) first; the kernel stays
zero-dependency. Reach me at [aniketh@agentmint.run](mailto:aniketh@agentmint.run)
· [@aniketh745](https://x.com/aniketh745). MIT licensed.
