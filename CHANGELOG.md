# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0]

- **New:** `agentmint verify` — independent, deterministic verification of a git
  diff or directory. It derives invariants from the spec, type definitions, and
  PR/ticket context, runs checks with no LLM in the decision loop, and emits a
  verification receipt (terminal box, JSON, or JSONL) with a SHA-256 hash.
- **Fix:** a bare `action: block` / `action: warn` on a tool with no concrete
  rules now blocks/warns the tool unconditionally instead of being a no-op.
- **Fix:** `blocked_patterns` (and `blocked_values`) now support glob matching —
  `*@competitor.com` matches `ceo@competitor.com`, while plain substrings stay
  backward compatible.
- **New:** `agentmint test --suite <prior-auth|coding-agent|refund-agent>` runs
  pre-built behavioural suites (28 scenarios) with `--json` and `--list`.
- **New:** `agentmint learn --from <path>` infers a spec from past violation
  receipts, with `--out` and `--merge`.
- Package renamed to `@npmsai/agentmint`; zero runtime dependencies.
- `openai` moved to `devDependencies` — it is only used for structural typing
  in the OpenAI adapter and is not imported at runtime.
- The CLI now reads its version from `package.json` instead of a hardcoded
  string, so `agentmint version` always matches the installed release.
- Added `LICENSE` to the published `files` array so the MIT license ships in
  the tarball.

## [0.1.1]

- Maintenance release.

## [0.1.0]

- Initial public release: validation, circuit breakers, and audit receipts for
  AI agent tool calls, with a CLI (`demo`, `init`, `watch`, `ci`, `diff`) and
  ESM/CJS builds.

[0.2.0]: https://github.com/aerf-spec/agentmint-app/releases/tag/v0.2.0
[0.1.1]: https://github.com/aerf-spec/agentmint-app/releases/tag/v0.1.1
[0.1.0]: https://github.com/aerf-spec/agentmint-app/releases/tag/v0.1.0
