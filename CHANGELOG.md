# CHANGELOG.md

## 1. Current state of `src/` and `test/`

There is no `test/` directory in the repository right now. All tests live in `src/**/*.test.ts`.

| File | Lines | What it does | Test coverage |
| --- | ---: | --- | --- |
| `src/adapters/adapters.test.ts` | 94 | Mock-based tests for raw, OpenAI, LangChain, and Vercel adapter wrappers. | This is the test suite for adapter wrappers. |
| `src/adapters/langchain.ts` | 14 | Wraps LangChain-style tools by intercepting `_call` and routing through `EnforcerFn`. | Directly covered by `src/adapters/adapters.test.ts` (`langchain_enforcement`, `langchain_preserves_name`). |
| `src/adapters/openai.ts` | 21 | Wraps OpenAI-style tool definitions and replaces `execute` with an enforced version. | Directly covered by `src/adapters/adapters.test.ts` (`openai_enforcement`, `openai_preserves_schema`). |
| `src/adapters/raw.ts` | 20 | Wraps plain async tool functions and normalizes params before passing to `EnforcerFn`. | Directly covered by `src/adapters/adapters.test.ts` (`raw_enforcement`, `raw_params`). |
| `src/adapters/vercel.ts` | 13 | Wraps Vercel-style tool objects by intercepting `execute`. | Directly covered by `src/adapters/adapters.test.ts` (`vercel_enforcement`). |
| `src/cli/demo.ts` | 1 | Placeholder module containing only `export {}`. | No direct tests. |
| `src/cli/entry.ts` | 1 | Placeholder module containing only `export {}`. This is also the configured CLI entrypoint. | No direct tests. |
| `src/enforce.ts` | 1 | Placeholder module containing only `export {}`. | No direct tests. |
| `src/harden.ts` | 1 | Placeholder module containing only `export {}`. | No direct tests. |
| `src/index.ts` | 1 | Package root entrypoint, currently empty (`export {}`). | No direct tests. |
| `src/log.test.ts` | 73 | Tests run ID generation, run-state creation, event logging, and block response helpers. | This is the test suite for `src/log.ts`. |
| `src/log.ts` | 65 | Provides `generateRunId`, `createRunState`, `logEvent`, and `blockResponse`. Imports `redact` and runtime crypto. | Directly covered by `src/log.test.ts`. |
| `src/matcher.test.ts` | 42 | Tests exact matching and simple `*` suffix wildcard behavior. | This is the test suite for `src/matcher.ts`. |
| `src/matcher.ts` | 9 | Implements exact and prefix-wildcard matching helpers. | Directly covered by `src/matcher.test.ts`. |
| `src/merkle.test.ts` | 90 | Tests canonicalization, proof generation, verification, tamper detection, and selective disclosure. | This is the test suite for `src/merkle.ts`. |
| `src/merkle.ts` | 120 | Implements deterministic canonicalization plus a SHA-256 based Merkle tree with proofs and verification. | Directly covered by `src/merkle.test.ts`. |
| `src/receipt.test.ts` | 123 | Tests receipt formatting and AERF record generation. | This is the test suite for `src/receipt.ts`. |
| `src/receipt.ts` | 134 | Builds AERF records from run state and renders a boxed text receipt. | Directly covered by `src/receipt.test.ts`. |
| `src/redact.test.ts` | 41 | Tests bound-value preservation and redaction of long strings, arrays, and objects. | This is the test suite for `src/redact.ts`. |
| `src/redact.ts` | 14 | Redacts non-bound complex values and long strings from tool params. | Directly covered by `src/redact.test.ts`. |
| `src/report.test.ts` | 91 | Tests empty, filtered, JSON, text, completed, and killed report cases. | This is the test suite for `src/report.ts`. |
| `src/report.ts` | 86 | Implements time-filter parsing plus text/JSON run reporting. | Directly covered by `src/report.test.ts`. |
| `src/types.test.ts` | 96 | Compile-shape tests for the core exported types. | This is the test suite for `src/types.ts`. |
| `src/types.ts` | 179 | Defines all shared SDK types: config, state, events, reports, AERF, and Merkle proofs. | Directly covered by `src/types.test.ts`. |

## 2. What `index.ts` exports

`src/index.ts` currently exports nothing. Its entire contents are:

```ts
export {};
```

Because `package.json` only exports the package root (`"."`), the published package root currently exposes no library API from `dist/index.js`.

## 3. What is in `package.json`

- Name: `agentmint`
- Version: `0.1.0`
- Package type: `module`
- License: `MIT`
- Node engine: `>=18`
- Bin:
  - `agentmint` → `dist/cli/entry.js`
- Exports:
  - `"."` only
  - `types` → `./dist/index.d.ts`
  - `import` → `./dist/index.js`
  - `require` → `./dist/index.cjs`
- Runtime dependencies:
  - None (`dependencies` field is absent)
- Dev dependencies:
  - `tsup`
  - `tsx`
  - `typescript`
  - `vitest`

## 4. Issues observed

- The package root export is effectively empty because `src/index.ts` contains only `export {}`. All implemented modules exist, but none are re-exported from the package root.
- `package.json` only exports `"."`, so there are no declared subpath exports for consumers to import modules like `matcher`, `receipt`, `report`, `merkle`, `log`, or the adapters directly.
- `src/cli/entry.ts` is empty even though `package.json` declares it as the `bin` target. The generated CLI binary will exist but currently does nothing.
- `src/cli/demo.ts`, `src/enforce.ts`, and `src/harden.ts` are still placeholders and provide no runtime behavior.
- There is no `test/` directory; all tests are colocated in `src/`.
- No broken imports were found by TypeScript.
- No current type errors were found by `npx tsc --noEmit`.

## 5. Verification output

### `npx tsc --noEmit`

```text
[no output]
```

### `npm test`

```text
> agentmint@0.1.0 test
> vitest run


 RUN  v3.2.6 /Users/aniketh/agentmint-app

 ✓ src/types.test.ts (6 tests) 2ms
 ✓ src/receipt.test.ts (8 tests) 3ms
 ✓ src/redact.test.ts (8 tests) 2ms
 ✓ src/matcher.test.ts (9 tests) 2ms
 ✓ src/report.test.ts (6 tests) 28ms
 ✓ src/log.test.ts (7 tests) 3ms
 ✓ src/merkle.test.ts (8 tests) 9ms
 ✓ src/adapters/adapters.test.ts (7 tests) 3ms

 Test Files  8 passed (8)
      Tests  59 passed (59)
   Start at  14:53:52
   Duration  310ms (transform 104ms, setup 0ms, collect 213ms, tests 53ms, environment 1ms, prepare 341ms)
```
