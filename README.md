# AgentMint

You asked your agent to fix one file. It also read `.env`, edited
`package.json`, ran `rm -rf`, and pushed to `main`.

**Runtime guardrails for AI agents** — validation, budget caps, circuit
breakers, and audit receipts. One line wraps your tools; every rule runs at the
tool boundary, *before* the call executes — not in a dashboard after you've paid.

```
npm install @npmsai/agentmint
npx @npmsai/agentmint demo a   # watch an agent go off-task
npx @npmsai/agentmint demo b   # watch budget caps stop it
```

## Wrap your tools

```typescript
import { harden } from '@npmsai/agentmint'
const tools = harden(myTools)
```

Every call is now logged. Works with the OpenAI, Anthropic, Vercel AI,
LangChain, and Mastra SDKs, or plain async functions — format auto-detected,
~17µs per call.

## Add rules

```yaml
# agentmint.spec.yaml
version: "1.0"
tools:
  write_file:
    requires: [read_file]          # no writing a file you never read
  run_command:
    input:
      properties:
        command:
          blocked_patterns: ["rm -rf", "DROP TABLE"]
          action: block
  git_push:
    requires: [run_tests]          # no pushing before tests pass
    input:
      properties:
        branch:
          blocked_values: ["main"]
          action: block
breakers:
  loop:
    max_identical_calls: 3         # break retry loops
```

```typescript
import { harden, loadSpec } from '@npmsai/agentmint'
const tools = harden(myTools, { spec: loadSpec('./agentmint.spec.yaml') })
```

## Budget guardrails

Agents retry too much, loop on failures, and spam expensive tools — and cost
compounds. Most cost tools bill you, then tell you. Budget guardrails price each
call and decide *before* it runs:

- **estimate** what a call costs · **cap** any single call · **budget** the whole
  run · **limit** how many times a tool may run.

```yaml
version: "1.1"
tools:
  search_web:
    cost: { estimate_usd: 0.03, max_cost_usd: 0.05, action: warn }
    limits: { max_calls_per_run: 3, action: block }   # stop retry loops
  browser_screenshot:
    cost: { estimate_usd: 0.08, max_cost_usd: 0.10, action: block }
breakers:
  budget: { max_total_usd: 5.00, action: block }      # ceiling for the run
```

Violations `warn` or `block`; `mode: 'shadow'` logs without blocking. Every
block names the rule and the numbers:

```
✗ browser_screenshot  est $0.18  run $0.29   over the $0.10 cap — blocked before it ran
```

Need dynamic or per-provider pricing? Pass code instead of YAML — code beats
YAML, and a dynamic estimate beats a static one:

```typescript
const tools = harden(myTools, {
  budget: 5.00,
  costCaps: { browser_screenshot: 0.10 },
  toolLimits: { search_web: { maxCallsPerRun: 3 } },
  costEstimator: (tool, params) =>
    tool === 'browser_screenshot' && params.fullPage ? 0.18 : 0.03,
})
```

**Why at the boundary, not a dashboard?** A dashboard reports spend once it's
gone. Here the estimate and caps are checked in the call path, before the tool
runs. The rule lives outside the model's context, so prompt injection can't
argue past it — the model just gets a blocked response it can recover from. Same
inputs, same decision, every run.

## What it catches

| What happened | Rule | Result |
|---|---|---|
| Refunded without looking up the order | requires | blocked |
| Wrote a file it never read | cross_ref | warned |
| Refunded more than the order total | max_ref | warned |
| Ran `rm -rf dist` | blocked_pattern | blocked |
| Pushed to `main` | blocked_value | blocked |
| Retried the same failing call 5× | loop_breaker | blocked |
| 20 calls in 10 seconds | velocity_breaker | blocked |
| Read `.env` credentials | blocked_pattern | blocked |
| One call estimated over its cap | cost_cap | blocked |
| Called an expensive tool too many times | usage_cap | blocked |
| Next call would blow the run budget | budget_cap | blocked |

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

## Receipts

```typescript
tools.__receipt()  // terminal receipt
tools.__log()      // JSONL events: timestamp, tool, args, reason, cost
tools.__state()    // counters
```

Boring, grep/jq-friendly JSONL, with an optional SHA-256 hash chain for tamper
evidence.

## More

```
npx @npmsai/agentmint init --example budget      scaffold a spec
npx @npmsai/agentmint test --suite coding-agent  pre-built stress tests
npx @npmsai/agentmint scan --dir ./src           generate a spec from code
npx @npmsai/agentmint learn --from incident.jsonl turn failures into rules
npx @npmsai/agentmint ci                          CI gate (exit 0/1)
```

Zero runtime dependencies. MIT.
