# AgentMint

You asked your agent to fix one file.
It also read .env, edited package.json, ran rm -rf, and pushed to main.

`npx @npmsai/agentmint demo a` — see it happen.

**Runtime guardrails for AI agents: validation, budget guardrails, circuit
breakers, audit receipts.** One line wraps your tools. Every rule runs at the
tool boundary — the moment a tool is called, before it executes — not in a
dashboard after you've already paid.

## See it

```
npx @npmsai/agentmint demo a   # scope creep: what your agent does off-task
npx @npmsai/agentmint demo b   # budget guardrails: cost caps at the boundary
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

## Budget guardrails

Agents retry too much, loop on failed tools, and spam expensive ones. Cost
compounds across retries and dependent restarts. Most cost tools tell you what
happened *after* you paid. Budget guardrails run at the tool boundary and stop
the call *before* it executes.

Four primitives, all deterministic:

- **Per-tool estimate** — what one call costs.
- **Per-call cap** — no single call may exceed `max_cost_usd`.
- **Per-run budget** — the whole run may not exceed `max_total_usd`.
- **Per-tool usage cap** — a tool may run at most N times per run.

Every violation resolves to `warn` or `block`, and in shadow mode it logs
without blocking. Blocks are legible — they name the exact rule and values:

```
blocked: browser_screenshot estimated $0.18 exceeds max_cost_usd $0.10
```

### YAML (the common path)

```yaml
# agentmint.spec.yaml
version: "1.1"
tools:
  search_web:
    cost:
      estimate_usd: 0.03
      max_cost_usd: 0.05
      action: warn
    limits:
      max_calls_per_run: 3    # stop retry loops
      action: block
  browser_screenshot:
    cost:
      estimate_usd: 0.08
      max_cost_usd: 0.10
      action: block
breakers:
  budget:
    max_total_usd: 5.00       # hard ceiling for the whole run
    action: block
```

```typescript
const tools = harden(myTools, { spec: loadSpec('./agentmint.spec.yaml') })
```

Start with `mode: 'shadow'` to watch the guardrails fire without blocking
anything, then flip to enforce once the numbers look right.

### Code (the escape hatch)

For dynamic or provider-specific pricing, pass an estimator. Code beats YAML;
a dynamic estimator beats a static estimate.

```typescript
const tools = harden(myTools, {
  budget: 5.00,
  costCaps: { browser_screenshot: 0.10 },
  toolLimits: { search_web: { maxCallsPerRun: 3 } },
  // priced from params/result/run state; called pre-flight to decide,
  // and post-execution to account actuals. Must be pure.
  costEstimator: (tool, params) =>
    tool === 'browser_screenshot' && params.fullPage ? 0.18 : 0.03,
})
```

### Coding-agent scenario

An agent asked to research competitors gets stuck refining the same web
search and reaching for full-page screenshots:

```
✓ search_web          est $0.03  run $0.03   search the field
✓ browser_screenshot  est $0.08  run $0.11   capture a pricing page
✗ browser_screenshot  est $0.18  run $0.29   full-page — over the $0.10 cap
✗ search_web          est $0.03  run …       6th call — over max_calls_per_run 5
✗ summarize           est $0.30  run $1.21   would push the run over $1.00
```

Nothing over-budget ever runs. `npx @npmsai/agentmint demo b` to watch it.

### YAML vs code

- **YAML** for common, portable, reviewable policy: fixed estimates, caps, and
  budgets a teammate can understand in 30 seconds and diff in review.
- **Code** for advanced estimation: pricing that depends on params, results, or
  run state, and org-specific overrides.

Use YAML by default. Reach for code only when a static number can't express the
cost. You never have to write code just to set a budget cap.

### Why the tool boundary, not a dashboard

A dashboard reports spend after the fact — the money is already gone, and the
retry loop already ran a hundred times. Guardrails sit in the call path: the
estimate is computed, the caps are checked, and the decision is made *before*
the tool runs. The rule isn't in the model's context, so a prompt injection
can't argue its way past it — the model just gets a blocked response it can
recover from. Same inputs, same decision, every run.

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
| Single call estimated over its cap | cost_cap | blocked |
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
