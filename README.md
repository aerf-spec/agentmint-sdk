# agentmint

Cryptographic receipts for AI agent actions. Wrap a tool call, get a signed,
hash-chained receipt; an auditor verifies it later — offline, with no
agentmint code and no trust in the agent, the app, or us.

Zero runtime dependencies (`node:crypto` only). Dual ESM/CJS. Node ≥ 18. MIT.

```
npm install @npmsai/agentmint
```

## The problem

Agents act — they call tools, move money, touch records — and the record of
what they did is usually a mutable log line the same process could rewrite or
quietly drop. That gap is now a named one: the EU AI Act requires high-risk
systems to keep tamper-evident event records ([Article 12](https://artificialintelligenceact.eu/article/12/)),
the [OWASP GenAI Security Project](https://genai.owasp.org/) lists
repudiation and untraceable agent actions among its core agentic threats, and
audit frameworks (SOC 2, AIUC-1) increasingly ask for evidence that a control
*ran*, not a claim that it exists.

The primitives to close the gap are old and boring, which is the good part:
Ed25519 signatures, hash chains, and RFC 6962 Merkle trees — the same
construction Certificate Transparency uses. agentmint applies them at the
agent tool boundary and implements the [AERF receipt
format](https://github.com/aerf-spec/aerf), so receipts verify across
independent implementations (this SDK, a Python producer, a Go verifier).

We won't oversell it: a receipt proves what was observed and signed, not what
*should* have happened. If every signer sees the same poisoned input, they all
sign it honestly — the spec documents these residuals, and so does
[`docs/parity.md`](docs/parity.md). What receipts do make impossible is silent
revision: a changed field breaks a signature, and a deleted receipt breaks the
hash chain *and* the sequence numbers.

## Wrap → receipt → verify

```ts
import { harden, loadSpec } from "@npmsai/agentmint";

// One line: every tool call is now policy-checked and receipted.
const tools = harden(myTools, {
  spec: loadSpec("agentmint.spec.yaml"),
  signing: { privateKeyPem },
});

await tools.issue_refund({ order_id: "A-1001", amount_usd: 40 });

tools.__receipts();        // signed, hash-chained decision receipts
tools.__verifyReceipts();  // { ok: true } — or the exact break index and why
```

Or drive the notary directly for full AERF evidence receipts:

```ts
import { Notary } from "@npmsai/agentmint";

const notary = new Notary({ stateDir: "./state" }); // chains survive restarts
const plan = notary.createPlan({
  user: "admin@example.com",
  action: "handle-claims",
  scope: ["submit:claim:*"],
  checkpoints: ["submit:claim:high-value:*"], // these always block
});

const receipt = notary.notarise({
  action: "submit:claim:CLM-9920",
  agent: "claims-agent",
  plan,
  evidence: { claim_id: "CLM-9920", amount_micros: 1250000000 },
});

notary.verifyChain(plan.id); // signatures + hash links + seq, per plan
```

Export everything for an auditor:

```
$ agentmint export --from receipts/ --out evidence.zip --plan plan.json --key notary_key.pem
$ unzip evidence.zip && node verify.mjs     # standalone — Node only, no agentmint
```

## The failure → regression-test loop

When a policy catches an agent misbehaving, the receipts become training data
for the policy itself:

```
$ agentmint learn --from receipts/incident.jsonl --out policy.yaml --test policy.test.ts
$ npx vitest run policy.test.ts             # hermetic replay of the incident
$ agentmint learn --from receipts/ --check policy.yaml   # exit 1 if an edit reopened a hole
$ agentmint learn --from receipts/ --repair policy.yaml  # add missing rules, cited to receipts
```

`npm run demo:learn` runs the whole loop, including `--check` catching a
deliberately broken policy.

## Cookbook

Every recipe below runs as written. The SDK recipes share two lines of setup,
and the JSONL recipe near the end reuses the `tools` handle from any recipe
above it:

```ts
import { harden, loadSpec } from "@npmsai/agentmint";
const ok = async () => ({ ok: true }); // stand-in tool used below
```

```ts
// Block a tool entirely
const tools = harden({ drop_table: ok }, { spec: loadSpec(`
version: "1.0"
tools:
  drop_table:
    action: block
`) });
await tools.drop_table({ name: "users" }); // { error: true, ... }, tool never runs
```

```ts
// Require tool B before tool A
const tools = harden({ lookup_order: ok, issue_refund: ok }, { spec: loadSpec(`
version: "1.0"
tools:
  issue_refund:
    requires: [lookup_order]
    action: block
`) });
await tools.issue_refund({ order_id: "ord_0001" }); // blocked: requires
```

```ts
// Cap a numeric arg by a prior tool's output (max_ref)
const tools = harden({ lookup_order: async () => ({ total: 40 }), refund: ok }, { spec: loadSpec(`
version: "1.0"
tools:
  refund:
    input:
      properties:
        amount:
          max_ref: "lookup_order.output.total"
          action: block
`) });
await tools.lookup_order({ order_id: "ord_0001" });
await tools.refund({ amount: 500 }); // blocked: 500 > 40
```

```ts
// Loop breaker: identical call, third strike
const tools = harden({ fetch_page: ok }, { spec: loadSpec(`
version: "1.0"
breakers:
  loop:
    max_identical_calls: 3
    action: block
`) });
await tools.fetch_page({ url: "https://example.com" }); // 1: allowed
await tools.fetch_page({ url: "https://example.com" }); // 2: allowed
await tools.fetch_page({ url: "https://example.com" }); // 3: blocked
```

```ts
// Per-run budget cap: the run is killed before it can pass $5
const tools = harden({ call_llm: ok }, { budget: 5, costEstimator: () => 2 });
await tools.call_llm({ prompt: "step 1" }); // $2
await tools.call_llm({ prompt: "step 2" }); // $4
await tools.call_llm({ prompt: "step 3" }); // killed: would pass $5
```

```ts
// Shadow mode: evaluate and record, but execute anyway
const tools = harden({ transfer: ok }, { mode: "shadow", spec: loadSpec(`
version: "1.0"
tools:
  transfer:
    action: block
`) });
await tools.transfer({ amount: 100 }); // runs; the log records the would-be block
```

```ts
// Sign receipts and verify the chain
import { generateKeyPairSync } from "node:crypto";
const { privateKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const tools = harden({ send_email: ok }, { signing: { privateKeyPem } });
await tools.send_email({ to: "ops@example.com" });
tools.__verifyReceipts(); // { ok: true }
```

```ts
// Export an evidence bundle an auditor can verify with Node alone
import { Notary, FileReceiptSink } from "@npmsai/agentmint";
import { writeFileSync } from "node:fs";
const notary = new Notary({ stateDir: "./state", sink: new FileReceiptSink("./receipts") });
const plan = notary.createPlan({ user: "ops@example.com", action: "close-tickets", scope: ["ticket:close:*"] });
notary.notarise({ action: "ticket:close:tkt_0007", agent: "support-agent", plan, evidence: { ticket_id: "tkt_0007" } });
writeFileSync("plan.json", JSON.stringify(plan, null, 2));
```

```
$ agentmint export --from receipts/ --out evidence.zip --plan plan.json --key state/notary_key.pem
$ unzip evidence.zip && node verify.mjs   # standalone: plan sig, receipt sigs, chain, root
```

```ts
// Generate a regression test from a run's receipts
import { formatJSONL } from "@npmsai/agentmint";
import { writeFileSync } from "node:fs";
writeFileSync("run.jsonl", formatJSONL(tools.__log(), tools.__state().runId) + "\n");
```

```
$ agentmint learn --from run.jsonl --out policy.yaml --test policy.test.ts
$ npx vitest run policy.test.ts   # hermetic replay of every caught failure
```

```
$ agentmint learn --from run.jsonl --check policy.yaml   # exit 0: policy still catches everything
$ agentmint learn --from run.jsonl --check edited.yaml   # exit 1 if an edit reopened a caught hole
```

[`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md) walks every demo and the local
benchmark with expected output. [`THREAT-MODEL.md`](THREAT-MODEL.md) states
what the receipts defend against and what they do not.

## Verify it yourself

```
$ node test/aerf-verify-poc.mjs   # 12/12 AERF conformance vectors
$ npx vitest run                  # full suite, incl. cross-producer byte-match vs the Python reference
$ npm run demo:trace              # control vs hardened run, gate internals
$ npm run demo:silence            # why deleted receipts can't go unnoticed
```

The cross-producer tests build the same logical receipt here and in the
Python reference producer from one Ed25519 seed and assert byte-identical
canonical payloads and identical signatures. [`docs/parity.md`](docs/parity.md)
documents every Python capability's status here, the wire-format guarantees,
and the deliberate divergences.

## Contributing

Small project, early days, honest bar: the oracle stays 12/12 and
`npx vitest run` stays green, or the change doesn't land.

- **Bugs / questions** — open an issue with a receipt (or vector) that
  reproduces it. A failing test is the best bug report.
- **Wire-format changes** — belong in the [AERF spec](https://github.com/aerf-spec/aerf)
  first; this SDK follows the spec, not the other way around.
- **New guardrails / adapters** — start in `src/experimental/`; the kernel
  (`src/kernel/`) stays zero-dependency and never imports experimental code.
- Before a PR: `npx tsc --noEmit && npx vitest run && npm run build`.

Talk to me: [aniketh@agentmint.run](mailto:aniketh@agentmint.run) ·
[@aniketh745](https://x.com/aniketh745). If you're putting agents in front of
real money or real records and receipts would help, I'd genuinely like to hear
what breaks.

## License

MIT
