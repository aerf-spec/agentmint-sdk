# AgentMint

Runtime guardrails for healthcare AI agents. One function. Every tool call checked.

## Demo

```
npx agentmint demo
```

Runs a simulated prior authorization with zero API keys. Shows a bind violation, a denied SUD record access, and a physician checkpoint — then prints the receipt.

## Install

```
npm install agentmint
```

Zero runtime dependencies. Zero config required. Node 18+.

## Quick start

```typescript
import { harden } from 'agentmint'

const tools = harden(myTools, {
  bind: { patient_id: 'PT-4827' },
  deny: ['delete_*', 'read_patient_sud_*'],
  checkpoint: ['submit_determination'],
  onCheckpoint: async (tool, params) => {
    return await getPhysicianApproval(tool, params)
  },
})

// Use tools exactly as before. The agent doesn't know they're wrapped.
const result = await agent.run(task, { tools })
```

## Three questions this answers

Your health system buyer will ask:

| Question | Config |
|----------|--------|
| "How do you prevent cross-patient data access?" | `bind: { patient_id }` |
| "Can your AI deny claims without physician review?" | `checkpoint: ['submit_determination']` |
| "How do you block access to 42 CFR Part 2 substance use data?" | `deny: ['read_patient_sud_*']` |

## How to adopt

**Day 1** — `harden(myTools)` with no config. Just logging. See what your agent does.

**Week 1** — Add `mode: 'shadow'` with your rules. See what *would* be blocked without blocking it.

**Week 2** — Flip to `mode: 'enforce'`. Wrong patient? Blocked. SUD records? Blocked. Determination without physician? Held.

## Config reference

| Field | Type | What it does |
|-------|------|-------------|
| `bind` | `Record<string, string>` | Lock parameter values. Wrong patient_id → blocked. |
| `allow` | `string[]` | Only these tools can run. Wildcards: `read_patient_*` |
| `deny` | `string[]` | These tools never run. Overrides allow. |
| `require` | `string[]` | Must complete before any checkpoint fires. |
| `checkpoint` | `string[]` | Pause for human approval via `onCheckpoint`. |
| `budget` | `number` | Max USD per run. Requires `costEstimator`. |
| `timeout` | `number` | Max seconds per run. |
| `retryLimit` | `number` | Max calls per tool name. |
| `mode` | `'enforce' \| 'shadow'` | Shadow logs blocks but doesn't enforce them. |
| `evidenceChain` | `boolean` | Enable Merkle tree for tamper-evident audit trail. |
| `silent` | `boolean` | Suppress stdout receipt. |

## What the agent sees when blocked

```typescript
{ error: true, tool: 'read_patient_record', message: 'Access denied. patient_id must be "PT-4827" for this run.' }
```

Human-readable. The agent can decide what to do next.

## Works with

Auto-detected. No framework config needed.

- **OpenAI** function calling
- **LangChain** StructuredTool arrays
- **Vercel AI SDK** tool records
- **Any** `Record<string, Function>`

## Evidence chain

```typescript
import { harden, buildRecord } from 'agentmint'

const tools = harden(myTools, { evidenceChain: true, ...config })
// ... agent runs ...
const record = buildRecord(tools.__state(), config)
// Machine-readable AERF evidence record with Merkle proofs
```

Health system sees access logs. Payer sees criteria results. Neither sees the other's data. Auditor verifies the full tree.

## API

- `tools.__state()` — current RunState
- `tools.__receipt()` — formatted terminal receipt
- `tools.__log()` — event array

Non-enumerable. Won't break framework tool iteration.

## Zero dependencies

```
npm audit  # clean
```

No transitive dependencies. No supply chain risk. One package.

## License

MIT
