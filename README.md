# AgentMint

Your AI agent has shell access, file access, and API keys.
What's stopping it from reading `.env`, running `rm -rf`, or pushing to `main`?

One line wraps your tools. Catches dangerous calls before they execute.

## See it

```
npx @npmsai/agentmint demo a
```

## Install

```
npm install @npmsai/agentmint
```

## Add to your agent

```typescript
import { harden } from '@npmsai/agentmint'

const tools = harden(myTools)
```

Every call is now logged. Works with OpenAI SDK, Anthropic SDK,
Vercel AI SDK, LangChain, Mastra, or plain async functions.
Format auto-detected. ~17µs overhead per call.

## Add rules

```yaml
# agentmint.spec.yaml
version: "1.0"
tools:
  write_file:
    requires: [read_file]
  run_command:
    input:
      properties:
        command:
          blocked_patterns: ["rm -rf", "DROP TABLE"]
          action: block
  git_push:
    requires: [run_tests]
    input:
      properties:
        branch:
          blocked_values: ["main"]
          action: block
breakers:
  loop:
    max_identical_calls: 3
```

```typescript
import { harden, loadSpec } from '@npmsai/agentmint'
const tools = harden(myTools, { spec: loadSpec('./agentmint.spec.yaml') })
```

## What it catches

| What happened | Rule | Result |
|---|---|---|
| Refunded without looking up the order | requires | blocked |
| Wrote a file it never read | cross_ref | warned |
| Refunded more than the order total | max_ref | warned |
| Ran `rm -rf dist` | blocked_pattern | blocked |
| Pushed to `main` | blocked_value | blocked |
| Retried same failing call 5x | loop_breaker | blocked |
| 20 calls in 10 seconds | velocity_breaker | blocked |
| Read `.env` credentials | blocked_pattern | blocked |

## Approve risky actions

```typescript
import { gate } from '@npmsai/agentmint'

const ok = await gate({
  action: 'delete_records',
  context: { table: 'users', count: 4200 },
  channel: 'slack',
  ttl: 300,
})
if (ok.approved) deleteRecords()
```

## Pre-built stress tests

```
npx @npmsai/agentmint test --suite coding-agent  # 8 scenarios
npx @npmsai/agentmint test --suite refund-agent  # 8 scenarios
npx @npmsai/agentmint test --suite prior-auth    # 12 scenarios
```

## Every call gets a receipt

```typescript
tools.__receipt()  // terminal receipt
tools.__log()      // event array
tools.__state()    // counters
```

JSONL events with timestamp, tool, args, and reason.
SHA-256 hash chain for tamper evidence.

## More tools

```
npx @npmsai/agentmint scan --dir ./src             generate spec from code
npx @npmsai/agentmint learn --from incident.jsonl  turn failures into rules
npx @npmsai/agentmint bench --framework demo       governance benchmark
npx @npmsai/agentmint verify --dir ./src           check code against spec
npx @npmsai/agentmint ci                           CI gate (exit 0/1)
```

## Zero runtime dependencies. MIT.
</content>
</invoke>
