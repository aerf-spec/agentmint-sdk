# agentmint

Your agent takes real actions: it moves money, changes records, sends messages. When a buyer or an auditor asks what it did, your logs don't prove anything. You could have edited them after the fact, and your buyer knows it.

agentmint gives every action a receipt, created the moment the action happens and linked to the one before it. Change any action afterward and verification fails, pointing straight at the one that was altered.

Your buyer checks the receipts themselves, on their own machine, with a single command. No account, no trust in you, and nothing from us has to be running.

**Security reviews shrink from weeks to days, disputes end without a call to you, and your word gets replaced by proof.**

## Add it to your agent

Install it, then wrap your tools. Every call is recorded and you get a receipt back.

```
npm install @npmsai/agentmint
```

```ts
import { harden } from "@npmsai/agentmint";

const tools = harden(myTools);          // observe-and-receipt mode
await tools.charge_card({ amount: 4000 });
console.log(tools.__receipt());         // a rendered receipt box for the run
```

That's the whole integration: one import, one wrap. Node 18+, nothing else to install.

## What your buyer sees

You hand them one file: a zip. Inside is every receipt plus a small script. They run one command and see pass or fail — on their own machine, with nothing from us installed.

```
$ agentmint export --from receipts/ --out evidence.zip --plan plan.json --key notary_key.pem
$ unzip evidence.zip && node verify.mjs   # standalone: plan sig, receipt sigs, chain, root
```

No account. No call back to us. If a receipt was touched, `verify.mjs` says so and names the one that changed.

## When a receipt catches something

You give the agent a boundary — say, a refund can never exceed the order it's refunding. The agent tries to refund $500 against a $40 order. agentmint stops the call before it runs and writes a receipt that records the block and the reason.

The blocked attempt is now evidence. The receipt is proof the boundary held, not a claim that a boundary exists somewhere.

## How the proof works

Now the details, for the reader who wants them.

Every receipt is signed with your private key (Ed25519) and carries the hash of the receipt before it — a hash chain. Editing one field breaks that receipt's signature; deleting a receipt breaks the chain and the sequence numbers on both sides. A per-run Merkle root (RFC 6962) commits to the whole set at once. These are the old, boring primitives behind Certificate Transparency, applied at your agent's tool boundary.

Turn on signing by passing a key:

```ts
import { generateKeyPairSync } from "node:crypto";
const privateKeyPem = generateKeyPairSync("ed25519").privateKey
  .export({ type: "pkcs8", format: "pem" }) as string;

const tools = harden(myTools, { signing: { privateKeyPem } });
await tools.send_email({ to: "ops@example.com" });
tools.__verifyReceipts(); // { ok: true } — or the exact break index and why
```

The verifier shipped in the export bundle is one small standalone file (about 150 lines, `node:crypto` only, nothing from agentmint). It implements the open [AERF receipt format](https://github.com/aerf-spec/aerf), so the same receipts verify across independent tools — this SDK, a Python producer, a Go verifier. Run the conformance check yourself:

```
$ node test/aerf-verify-poc.mjs   # 12/12 AERF conformance vectors
$ npx vitest run                  # full suite, incl. cross-producer byte-match vs the Python reference
```

One honest limit: a receipt proves what was observed and signed, not what *should* have happened; what it makes impossible is silent revision. If a bad input reaches every signer, they all sign it honestly — the receipt records what happened, not a judgment that it was right.

## Setting boundaries

A signed spec says what each tool may do: scope (allow/deny), order (`requires`), and block rules. The `max_ref` rule bounds an argument by a prior tool's output — so a refund can't exceed the order:

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

## Compliance

Auditors now want evidence that a control *ran*, not a claim that it exists. The EU AI Act requires tamper-evident event records for high-risk systems ([Article 12](https://artificialintelligenceact.eu/article/12/)); the [OWASP GenAI Security Project](https://genai.owasp.org/) lists repudiation among its core agentic threats; SOC 2, HIPAA, and AIUC-1 reviews want proof a decision happened. A signed receipt is that proof.

## How policies improve over time

When a run trips a rule, its receipts become the policy. `agentmint learn` reads past violations, writes the spec that would have caught them, and generates a regression test that fails if a later edit reopens the hole:

```
$ agentmint learn --from receipts/incident.jsonl --out policy.yaml --test policy.test.ts
$ agentmint learn --from receipts/ --check edited.yaml   # exit 1 if an edit reopened a hole
```

## Links

`harden()` wraps raw, OpenAI, Anthropic, and LangChain tool shapes; bindings for the [Vercel AI SDK](examples/vercel-ai-sdk/) and [durable agents](examples/prior-auth-eve/) live in `examples/`. What receipts do and don't defend against is in [`THREAT-MODEL.md`](THREAT-MODEL.md#proof-layers); wire-format guarantees are in [`docs/parity.md`](docs/parity.md).

Reach me at [aniketh@agentmint.run](mailto:aniketh@agentmint.run) · [@aniketh745](https://x.com/aniketh745). MIT licensed.
