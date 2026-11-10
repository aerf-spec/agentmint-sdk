# CLAUDE.md

filet reasoning demo: `app/` is the demo server, `src/` is the trimmed SDK core it imports
(receipts, chains, plans, Merkle, commitments, trace links). See README.md.

## Verification

Before wrapping up changes:
- Run `npx tsc --noEmit`
- Run `npm test`
- Start the server (`npm start`) and `curl -N "localhost:4173/events?speed=10"`: the stream must end
  with `done`, and every `signed` must be followed by `anchored` + `verified`.
