# Cookbook

Every recipe below runs as written. The SDK recipes share two lines of setup,
and the JSONL recipe near the end reuses the `tools` handle from any recipe
above it:

```ts
import { harden, loadSpec } from "@npmsai/agentmint";
const ok = async () => ({ ok: true }); // stand-in tool used below
```

```ts
// Block a tool entirely
const tools = harden({ delete_patient_record: ok }, { spec: loadSpec(`
version: "1.0"
tools:
  delete_patient_record:
    action: block
`) });
await tools.delete_patient_record({ patient_id: "PT-4821" }); // { error: true, ... }, tool never runs
```

```ts
// Require tool B before tool A
const tools = harden({ lookup_auth: ok, submit_prior_auth: ok }, { spec: loadSpec(`
version: "1.0"
tools:
  submit_prior_auth:
    requires: [lookup_auth]
    action: block
`) });
await tools.submit_prior_auth({ auth_id: "PA-2210" }); // blocked: requires
```

```ts
// Cap a numeric arg by a prior tool's output (max_ref)
const tools = harden({ lookup_auth: async () => ({ authorized_amount: 40 }), submit_prior_auth: ok }, { spec: loadSpec(`
version: "1.0"
tools:
  submit_prior_auth:
    input:
      properties:
        billed_amount:
          max_ref: "lookup_auth.output.authorized_amount"
          action: block
`) });
await tools.lookup_auth({ patient_id: "PT-4821" });
await tools.submit_prior_auth({ billed_amount: 500 }); // blocked: 500 > 40
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
const tools = harden({ submit_prior_auth: ok }, { signing: { privateKeyPem } });
await tools.submit_prior_auth({ auth_id: "PA-2210" });
tools.__verifyReceipts(); // { ok: true }
```

```ts
// Export an evidence bundle an auditor can verify with Node alone.
// The Notary layer ships on the @npmsai/agentmint/notary subpath.
import { Notary, FileReceiptSink } from "@npmsai/agentmint/notary";
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

[`WALKTHROUGH.md`](WALKTHROUGH.md) walks every demo and the local benchmark with
expected output. [`../THREAT-MODEL.md`](../THREAT-MODEL.md) states what the
receipts defend against and what they do not.
