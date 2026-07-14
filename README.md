# agentmint

Every agent action gets a signed, tamper-evident receipt that a third party can
verify offline — no agentmint code, no network, no trust in the agent, the app,
or us. Wrap a tool call, get an Ed25519-signed, hash-chained receipt; an auditor
checks it later, independently.

Zero runtime dependencies (`node:crypto` only). Dual ESM/CJS. Node ≥ 18. MIT.
Install with `npm install @npmsai/agentmint`.

## What a receipt is

A receipt is a signed record of one tool decision:

- **Signed** — Ed25519 over a canonical payload; change any field and the
  signature breaks.
- **Hash-chained** — each receipt commits to the previous one's hash and a
  sequence number, so a deleted receipt breaks the chain *and* the numbering.
- **Offline-verifiable** — verification needs only the public key and the bytes.

A receipt proves what was observed and signed, not what *should* have happened;
what it makes impossible is silent revision. The primitives are old and boring —
Ed25519, hash chains, RFC 6962 Merkle trees — applied at the tool boundary per
the [AERF format](https://github.com/aerf-spec/aerf), so receipts verify across
independent implementations (this SDK, a Python producer, a Go verifier).

## Wrap, receipt, verify

No spec, no keys — every call is recorded and you get a receipt:

```ts
import { harden } from "@npmsai/agentmint";

const tools = harden(myTools);          // observe-and-receipt mode
await tools.charge_card({ amount: 4000 });
console.log(tools.__receipt());         // a rendered receipt box for the run
```

Pass a key and every decision emits an Ed25519-signed, hash-chained receipt;
`__verifyReceipts()` checks signatures, hash links, and sequence numbers:

```ts
import { generateKeyPairSync } from "node:crypto";
const privateKeyPem = generateKeyPairSync("ed25519").privateKey
  .export({ type: "pkcs8", format: "pem" }) as string;

const tools = harden(myTools, { signing: { privateKeyPem } });
await tools.send_email({ to: "ops@example.com" });
tools.__verifyReceipts(); // { ok: true } — or the exact break index and why
```

`npm run demo:tamper` signs a five-decision run, flips one byte, and shows the
chain catch it — real signed output, no install.

## Export — hand an auditor a self-verifying bundle

The product for a compliance or InfoSec buyer. `agentmint export` bundles
receipts, the signed plan, and a Merkle root into a zip with a standalone Node
verifier — no agentmint, no network:

```
$ agentmint export --from receipts/ --out evidence.zip --plan plan.json --key notary_key.pem
$ unzip evidence.zip && node verify.mjs   # standalone: plan sig, receipt sigs, chain, root
```

For plan-bound AERF evidence directly, use the `Notary` on the
[`@npmsai/agentmint/notary`](docs/cookbook.md) subpath.

## What the receipt is checked against — the plan and gate

Before a call runs, a deterministic gate checks it against a signed spec: scope
(allow/deny), checkpoints (`requires`), and block rules; the receipt records
that decision. The `max_ref` rule bounds an argument by a prior tool's output —
so a refund can't exceed the order:

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

More rules, each one line — full versions in [`docs/cookbook.md`](docs/cookbook.md):

| Recipe | The line that matters |
|---|---|
| Block a tool | `drop_table: { action: block }` |
| Require B before A | `issue_refund: { requires: [lookup_order] }` |
| Loop breaker | `breakers: { loop: { max_identical_calls: 3 } }` |
| Per-run budget cap | `harden(tools, { budget: 5, costEstimator })` |
| Shadow mode (record, don't block) | `harden(tools, { mode: "shadow" })` |

## How it improves over time — learn

The regression loop, not a headline feature: when a run trips a rule, its
receipts become the policy. `learn` infers spec YAML from past violations and
generates a hermetic regression test that flags any later edit reopening a
caught hole.

```
$ agentmint learn --from receipts/incident.jsonl --out policy.yaml --test policy.test.ts
$ agentmint learn --from receipts/ --check edited.yaml   # exit 1 if an edit reopened a hole
```

## Compliance

Auditors now ask for evidence that a control *ran*, not a claim that it exists.
The EU AI Act requires tamper-evident event records for high-risk systems
([Article 12](https://artificialintelligenceact.eu/article/12/)); the [OWASP
GenAI Security Project](https://genai.owasp.org/) lists repudiation among its
core agentic threats; SOC 2, HIPAA, and AIUC-1 reviews want proof a decision
happened. A signed receipt is that proof.

## Verify it yourself

```
$ node test/aerf-verify-poc.mjs   # 12/12 AERF conformance vectors
$ npx vitest run                  # full suite, incl. cross-producer byte-match vs the Python reference
$ npm run demo:trace              # control vs hardened run, gate internals
```

`harden()` wraps raw, OpenAI, Anthropic, and LangChain tool shapes; bindings for
the [Vercel AI SDK](examples/vercel-ai-sdk/) and [durable agents](examples/prior-auth-eve/)
live in `examples/`. The proof layers and what receipts do and don't defend
against are in [`THREAT-MODEL.md`](THREAT-MODEL.md#proof-layers);
[`docs/parity.md`](docs/parity.md) has the wire-format guarantees.

## Contributing

The oracle stays 12/12 and `npx vitest run` stays green, or the change doesn't
land. Wire-format changes belong in the [AERF
spec](https://github.com/aerf-spec/aerf) first; the kernel stays zero-dependency.
Reach me at [aniketh@agentmint.run](mailto:aniketh@agentmint.run) ·
[@aniketh745](https://x.com/aniketh745). MIT licensed.
