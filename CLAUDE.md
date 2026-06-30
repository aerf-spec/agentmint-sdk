# CLAUDE.md

## Project Overview

`agentmint` is a zero-runtime-dependency TypeScript SDK + CLI for AI agent guardrails. It sits at the tool boundary of AI agents and validates tool I/O, provides circuit breakers, and emits audit receipts.

Current constraints:
- Node `>=18`
- Dual ESM/CJS output via `tsup`
- No entries in `dependencies`
- Source lives under `src/`

## Architecture

- **Spec parser** (`src/spec.ts`): Inline YAML subset parser, loads `agentmint.spec.yaml`
- **Session store** (`src/session.ts`): Tracks tool inputs/outputs for cross-tool validation
- **Cross-ref engine** (`src/cross-ref.ts`): Validates tool I/O against spec rules
- **Circuit breakers** (`src/breakers.ts`): Loop, velocity, cost detection
- **Enforce pipeline** (`src/enforce.ts`): Integrates everything, backward-compatible
- **Adapters** (`src/adapters/`): OpenAI, Anthropic, LangChain, Vercel, Raw, Generic
- **JSONL receipts** (`src/jsonl.ts`): Event emitter + parser
- **CLI** (`src/cli/`): demo, watch, init, ci, diff commands

## Important Files

- `src/types.ts`: single source of truth for all SDK types
- `src/enforce.ts`: the core enforcement pipeline
- `src/spec.ts`: YAML spec parser
- `src/session.ts`: session store for cross-tool validation

## Commands

```bash
npm install
npx tsc --noEmit
npm test
npm run build
npm run demo
tsx --test tests/integration.test.ts  # full rogue agent test suite
```

## CLI

```bash
agentmint demo [1|2|3|a]    # run demo scenarios
agentmint init [--example refund|coding|data]  # generate spec
agentmint watch              # real-time validation
agentmint ci                 # CI gating (exit 0/1)
agentmint diff f1 f2         # compare runs
```

## Verification

Before wrapping up changes:
- Run `npx tsc --noEmit`
- Run `npm test`
- Run `tsx --test tests/integration.test.ts`
- Run `npm run build` when package output or exports changed
