# agentmint

Tamper-evident plain-language receipts for Healthcare RCM agents. For startup founders selling to healthcare systems.
Give your clinic or hospital proof your agent is safe and compliant end-to-end, in a way they understand, without YOU having to dig through logs and THEM having to take your word for it.


**Building an agent?** Start below.
**Received an evidence packet?** Read [FOR-REVIEWERS.md](FOR-REVIEWERS.md). You do not need to install anything.

## See it in 60 seconds

```
npx @npmsai/agentmint demo
```

It runs a prior auth session: one in-scope patient record read, one prior auth submitted, one out-of-scope record read blocked before it runs, and one appeal held for a clinician whose approval is itself a signed receipt. Then it flips one byte and verification points straight at the receipt that changed.

## Add it to your agent. 

```
npm install @npmsai/agentmint
```

```ts
import { harden } from "@npmsai/agentmint";

const tools = harden(myTools);                       // observe and receipt, nothing blocked
await tools.submit_prior_auth({ auth_id: "PA-2210", billed_amount: 40 });
console.log(tools.__receipt());                      // the receipt box for this run
```

One import, one wrap. `harden()` fits raw, OpenAI, Anthropic, and LangChain tool shapes. For the Vercel AI SDK and durable agents, see [examples/](examples/).

## Hand your buyer the packet

You give them one file: a zip. Inside is every receipt plus a small verifier. They run one command and see pass or fail, on their own machine.

```
$ agentmint export --from receipts/ --out evidence.zip --plan plan.json --key notary_key.pem
$ unzip evidence.zip && node verify.mjs
```

They need Node 18. They do not need agentmint, an account, or trust in you. If a receipt was touched, the verifier says so and names the one that changed. See a finished packet in [examples/sample-evidence-packet/](examples/sample-evidence-packet/).

## Control what gets receipted

The receipt records a decision against a signed plan, which is what makes it evidence that a control ran. Here two rules: an appeal is held for a clinician, and a prior auth can never bill above the amount the payer authorized.

```ts
import { harden, loadSpec } from "@npmsai/agentmint";

const tools = harden({ lookup_auth: async () => ({ authorized_amount: 40 }), submit_prior_auth }, {
  spec: loadSpec(`
version: "1.0"
tools:
  submit_prior_auth:
    input:
      properties:
        billed_amount:
          max_ref: "lookup_auth.output.authorized_amount"
          action: block
`),
});
await tools.lookup_auth({ patient_id: "PT-4821" });
await tools.submit_prior_auth({ billed_amount: 500 }); // blocked: 500 over 40, the prior auth never runs
```

More rules, each one line. Full versions in [`docs/cookbook.md`](docs/cookbook.md):

| Recipe | The line that matters |
|---|---|
| Block a tool | `delete_patient_record: { action: block }` |
| Require B before A | `submit_prior_auth: { requires: [lookup_auth] }` |
| Hold for a clinician | `submit_appeal: { requires_approval: true }` |
| Loop breaker | `breakers: { loop: { max_identical_calls: 3 } }` |
| Per-run budget cap | `harden(tools, { budget: 5, costEstimator })` |
| Shadow mode (record, do not block) | `harden(tools, { mode: "shadow" })` |

This section supports the evidence story. It is not a second product.

## How the proof works

Now the details, for the reader who wants them.

Every receipt is signed with your private key (Ed25519) and carries the hash of the receipt before it, a hash chain. Editing one field breaks that receipt's signature. Deleting a receipt breaks the chain and the sequence numbers on both sides. A per-run Merkle root (RFC 6962) commits to the whole set at once. These are the old, boring primitives behind Certificate Transparency, applied at your agent's tool boundary.

Turn on signing by passing a key:

```ts
import { generateKeyPairSync } from "node:crypto";
const privateKeyPem = generateKeyPairSync("ed25519").privateKey
  .export({ type: "pkcs8", format: "pem" }) as string;

const tools = harden(myTools, { signing: { privateKeyPem } });
await tools.submit_prior_auth({ auth_id: "PA-2210" });
tools.__verifyReceipts(); // { ok: true }, or the exact break index and why
```

The verifier shipped in the export bundle is one small standalone file (about 150 lines, `node:crypto` only, nothing from agentmint). It implements the open [AERF receipt format](https://github.com/aerf-spec/aerf), so the same receipts verify across independent tools: this SDK, a Python producer, a Go verifier. Run the conformance check yourself:

```
$ node test/aerf-verify-poc.mjs   # 12/12 AERF conformance vectors
$ npx vitest run                  # full suite, incl. cross-producer byte-match vs the Python reference
```

One honest limit: a receipt proves what was observed and signed, not what *should* have happened. What it makes impossible is silent revision. If a bad input reaches every signer, they all sign it honestly, and the receipt records what happened, not a judgment that it was right. Happy to talk with those in the space on how to develop a good framework to judge appropriateness of actions that are otherwise in-policy!

The Notary API for plan-bound evidence, and the three proof layers that stack behind a packet, are in [`THREAT-MODEL.md`](THREAT-MODEL.md#proof-layers). A newcomer does not need them to ship.

## How it improves over time

This is the regression loop, not a headline. When a run trips a rule, its receipts become the policy. `agentmint learn` reads past violations, writes the spec that would have caught them, and generates a test that fails if a later edit reopens the hole. The goal is that your buyer gets more transparency over time.

```
$ agentmint learn --from receipts/incident.jsonl --out policy.yaml --test policy.test.ts
$ agentmint learn --from receipts/ --check edited.yaml   # exit 1 if an edit reopened a hole
```

## For your compliance mapping

The receipt fields map to specific control questions. Full table in [`docs/compliance-crosswalk.md`](docs/compliance-crosswalk.md).

- HIPAA 164.312(a) access control and 164.312(b) audit controls: the scope decision and the signed chain.
- The clinician determination requirement (CMS-4201-F, California SB 1120): the checkpoint approval receipt.
- AIUC-1 action authorization and audit trail controls: the in-policy verdict and the plan binding.

## Verify it yourself

```
$ npx @npmsai/agentmint demo      # the prior auth session, no keys, no network
$ node test/aerf-verify-poc.mjs   # 12/12 AERF conformance vectors
$ npx vitest run                  # the full suite
```

Contributions welcome: if you can make a receipt lie or a deletion invisible, open an issue with a failing vector. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

Reach me at [aniketh@agentmint.run](mailto:aniketh@agentmint.run) · [@aniketh745](https://x.com/aniketh745). MIT licensed.
