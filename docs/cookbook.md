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
