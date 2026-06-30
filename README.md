# AgentMint

Runtime guardrails for AI agents. Validation · Circuit breakers · Audit receipts.

Zero runtime dependencies. One YAML spec. One line of code.

## Try it now

```
npx agentmint demo a
```

Three rogue agent scenarios in 10 seconds, no API keys.

## The problem

Your AI agent calls a tool, gets a 200 back, and keeps going — even when the data is wrong. It refunds the wrong customer. It overwrites a file it never read. It retries 15 times with identical args, burning tokens. Nobody catches it until production breaks.

## What AgentMint does

AgentMint sits at the tool boundary and catches three things:

**Validation** — Cross-ref tool outputs against inputs. Did the refund match the order that was looked up? Is the amount within the order total? Was the prerequisite step completed first?

**Circuit breakers** — Stop runaway loops (identical-arg detection), velocity spikes (too many calls too fast), and cost overruns before they burn money.

**Audit receipts** — JSONL stream of every tool call, every violation, every enforcement decision. Queryable with grep/jq. Deterministic, no LLM judge needed.

## Install

```
npm install agentmint
```

## Quick start

```typescript
import { harden } from 'agentmint'

// Wrap your tools — one line
const tools = harden(myTools, {
  spec: loadSpec('./agentmint.spec.yaml'),
})

// Use tools exactly as before. The agent doesn't know they're wrapped.
const result = await agent.run(task, { tools })
```

## Spec file

```yaml
# agentmint.spec.yaml
version: "1.0"

tools:
  issue_refund:
    requires:
      - lookup_order
    input:
      properties:
        amount:
          max_ref: lookup_order.output.total
        order_id:
          cross_ref: lookup_order.input.order_id

  run_command:
    input:
      properties:
        command:
          blocked_patterns:
            - "rm -rf"
            - "DROP TABLE"
          action: block

  git_push:
    input:
      properties:
        branch:
          blocked_values: ["main", "master"]
          action: block

breakers:
  loop:
    max_identical_calls: 5
    action: block
  velocity:
    max_calls_per_window: 15
    window_seconds: 30
    action: block
```

## CLI

| Command | What it does |
|---------|-------------|
| `agentmint demo [1\|2\|3\|a]` | Run demo scenarios showing all three capabilities |
| `agentmint init [--example refund\|coding\|data]` | Generate a starter spec |
| `agentmint watch` | Real-time validation against your spec |
| `agentmint ci` | Validate and exit 0/1 for CI gating |
| `agentmint diff <run1> <run2>` | Compare behavior between two runs |

## What it catches

| Violation | Example | Default action |
|-----------|---------|---------------|
| `requires` | Refund without prior order lookup | `block` |
| `cross_ref` | Refund order_id ≠ looked-up order_id | `warn` |
| `max_ref` | Refund amount > order total | `warn` |
| `blocked_pattern` | Command contains "rm -rf" | `block` |
| `blocked_value` | Push to "main" branch | `block` |
| `loop_breaker` | 5 identical calls (same tool + args) | `block` |
| `velocity_breaker` | 15 calls in 30 seconds | `block` |
| `cost_breaker` | Total cost exceeds $10 | `block` |

## Severity model

Two actions: `warn` (log + continue) and `block` (reject the call). Configurable per-rule with smart defaults — validation rules default to `warn`, breakers and blocked patterns default to `block`. The existing `checkpoint` mechanism provides human-in-the-loop approval for sensitive operations.

## Works with

Auto-detected. No framework config needed.

```typescript
// OpenAI SDK
const tools = harden(openaiTools)

// Anthropic SDK
const tools = harden(anthropicTools)

// Vercel AI SDK
const tools = harden(vercelTools)

// LangChain
const tools = harden(langchainTools)

// Any function
const tools = harden({ myTool: async (params) => { ... } })

// Framework-agnostic single tool
import { watchTool } from 'agentmint'
const safeTool = watchTool('myTool', myFn, enforcer)
```

## Programmatic config

Works without a spec file — configure in code:

```typescript
const tools = harden(myTools, {
  bind: { customer_id: 'CUST-123' },
  deny: ['delete_*'],
  checkpoint: ['send_email'],
  budget: 5.00,
  timeout: 60,
  retryLimit: 3,
  mode: 'shadow',  // log violations without blocking
  onCheckpoint: async (tool, params) => getApproval(tool, params),
  costEstimator: (tool, params, result) => 0.01,
})
```

## API

```typescript
import {
  harden,
  loadSpec,
  watchTool,
  AgentMintReport,
  buildRecord,
  formatJSONL,
  parseJSONL,
} from 'agentmint'
```

After wrapping:
- `tools.__state()` — current RunState
- `tools.__receipt()` — formatted terminal receipt
- `tools.__log()` — event array

Non-enumerable — won't break framework tool iteration.

## Zero dependencies

```
npm audit  # clean
```

No transitive dependencies. No supply chain risk. One package.

## License

MIT
