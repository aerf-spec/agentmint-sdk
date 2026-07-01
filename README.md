# AgentMint

Independent verification for AI agent tool calls and AI-generated code.
Policy enforcement · human approval · tamper-evident receipts.
One npm install. Framework-agnostic. Zero runtime dependencies.

## The problem

The AI agent writes the code. Then writes the tests. The tests pass.
But they validate what the agent built, not what you asked for.
Meanwhile the agent's tool calls — refunds, database writes, git
pushes — execute with no independent check.

## Try it (10 seconds)

```bash
npx @npmsai/agentmint demo a
```

## Verify your code

```bash
agentmint verify --dir ./src --spec agentmint.spec.yaml
```

## Benchmark a framework

```bash
agentmint bench --framework demo
```

## Test your agent before deploy

```bash
agentmint test --suite coding-agent
```

## Add human approval

```typescript
import { gate } from '@npmsai/agentmint'

const result = await gate({
  action: 'delete_records',
  context: { table: 'users', count: 4200 },
  channel: 'slack',
  ttl: 300,
})

if (result.approved) executeAction()
```

## Auto-generate a spec

```bash
agentmint scan --dir ./src
```

## Learn from failures

```bash
agentmint learn --from receipts/incident.jsonl
```

## What it catches

| Rule | Example | Default |
|------|---------|---------|
| requires | Refund without lookup | block |
| action: block | delete_account | block |
| cross_ref | Wrong order ID | warn |
| max_ref | Amount > order total | warn |
| blocked_pattern | rm -rf | block |
| blocked_value | push to main | block |
| loop_breaker | 5 identical calls | block |
| velocity | 15 calls in 30s | block |
| gate | Unapproved action | block |
| verify | Invariant violation | block |

## CLI

| Command | What |
|---------|------|
| verify | Independent verification with receipt |
| bench | Governance analysis across frameworks |
| test | Pre-built compliance test suites |
| gate | Human approval workflow |
| scan | Auto-generate spec from source |
| learn | Generate spec from failure receipts |
| demo | Rogue agent scenarios |
| watch | Real-time validation |
| init | Starter spec |
| ci | CI gate (exit 0/1) |
| diff | Compare two runs |

## Add to your agent (one line)

```typescript
import { harden, loadSpec } from '@npmsai/agentmint'
const tools = harden(myTools, { spec: loadSpec('./agentmint.spec.yaml') })
```

## Works with everything

OpenAI, Anthropic, Vercel AI, LangChain, Mastra, or plain async functions.

## Zero runtime dependencies. MIT.
