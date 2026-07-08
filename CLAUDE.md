# CLAUDE.md

See [AGENTS.md](AGENTS.md) for the wedge, repo shape, canonical files, and CLI.

## Verification

Before wrapping up changes:
- Run `npx tsc --noEmit`
- Run `npm test`
- Run `tsx --test tests/integration.test.ts`
- Run `npm run build` when package output or exports changed
