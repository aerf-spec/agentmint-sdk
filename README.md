# agentmint-sdk

**Cryptographic receipts for agent actions.** One-line instrumentation.
Tamper-evident audit trails for agentic workflows.

## Why this exists

AI agents act — they call tools, move money, touch records — but they leave no
verifiable trace of what they did, when, or with what result. Regulators,
auditors, and compliance teams can't trust what they can't verify, which is what
keeps agentic workflows out of regulated environments.

AgentMint sits at the tool boundary and turns every agent action into a signed,
hash-chained receipt an auditor can verify later — without trusting the agent,
the app, or the vendor.

## The wedge: wrap → receipt → verify

```ts
import {
  createSession,
  recordInput,
  recordOutput,
  buildRecord,
  verify,
} from "@npmsai/agentmint";

// 1. WRAP — record each agent tool call into a session
const session = createSession();
recordInput(session, "issue_refund", { order_id: "A-1001", amount_usd: 40 });
const result = await issueRefund({ order_id: "A-1001", amount_usd: 40 });
recordOutput(session, "issue_refund", result);

// 2. RECEIPT — mint a signed, hash-chained record of what happened
const receipt = buildRecord(state, config); // -> AERFRecord (JSONL-serializable)

// 3. VERIFY — an auditor checks the receipt against the spec, later, offline
const report = await verify({ dir: "./src", spec: "agentmint.spec.yaml" });
console.log(report.summary); // { verified, failed, unverified, blocked }
```

Zero runtime dependencies. Dual ESM/CJS. Node `>=18`.

## Install

```
npm install @npmsai/agentmint
```

## Core API

### 1. `buildRecord()` — mint a signed receipt for an agent run

Turns the run state captured at the tool boundary into an `AERFRecord`: a
tamper-evident summary of every tool call, its result, bound values, and an
optional Merkle root over the event chain.

```ts
import { buildRecord, formatReceipt } from "@npmsai/agentmint";

const receipt = buildRecord(state, config);
console.log(formatReceipt(state, config)); // human-readable receipt
```

### 2. `verify()` — verify a receipt or a set of changes against a spec

Checks claims (invariants, policies, patterns, properties) and returns a
`VerifyReceipt` — the evidence an auditor reads. Runs offline; no agent required.

```ts
import { verify, formatVerifyReceipt } from "@npmsai/agentmint";

const receipt = await verify({ diff: "pr.diff", spec: "agentmint.spec.yaml" });
console.log(formatVerifyReceipt(receipt));
```

### 3. `gate()` — pre-flight approval before an action runs

Blocks on a human (console / Slack / webhook) before a risky action executes,
and chains each decision into a hash chain so approvals are auditable too.

```ts
import { gate } from "@npmsai/agentmint";

const decision = await gate({ action: "deploy", context: { env: "prod" } });
if (!decision.approved) throw new Error(`Denied: ${decision.reason}`);
// decision.hash is chained to the previous gate call
```

### 4. `createSession()` — group tool I/O into an auditable session

Tracks tool inputs, outputs, and a hashed call history so receipts can be built
and cross-tool references resolved.

```ts
import { createSession, recordInput, recordOutput, resolveRef } from "@npmsai/agentmint";

const session = createSession();
recordInput(session, "lookup_order", { order_id: "A-1001" });
recordOutput(session, "lookup_order", { total_usd: 40 });
```

## What gets recorded

Every receipt (`AERFRecord`) is JSONL-serializable evidence:

| Field          | Description                                    | Example value            |
| -------------- | ---------------------------------------------- | ------------------------ |
| `runId`        | Unique id for the agent run                    | `"amr_abcd1234"`         |
| `mode`         | `enforce` (blocking) or `shadow` (observe)     | `"enforce"`              |
| `boundValues`  | Identity values pinned for the run             | `{ patient_id: "PT-100" }` |
| `events[]`     | Each tool call: name, result, reason, params   | `{ tool: "issue_refund", result: "allowed" }` |
| `summary`      | Calls, executed, blocked, held, cost, elapsed  | `{ calls: 4, blocked: 1 }` |
| `evidenceRoot` | Merkle root over all events (when enabled)     | `"9f2c…"`                |

## Use cases

- SOC 2 Type II evidence for agentic workflows
- AIUC-1 / EU AI Act compliance artifacts
- Healthcare agent billing audit trails
- Multi-agent pipeline integrity checks

## Experimental modules

Optional guardrails that build on the kernel but aren't part of the receipt
wedge live in [`src/experimental/`](src/experimental/): budget caps, spec
learning, the `harden()` one-line auto-wrapper, circuit breakers, enforcement,
and framework adapters (OpenAI, Anthropic, LangChain, Vercel, raw). The
always-on verification primitives they rely on live in
[`src/kernel/`](src/kernel/).

## License

MIT
