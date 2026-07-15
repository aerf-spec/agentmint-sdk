# A sample evidence packet

This folder holds `evidence.zip`, a finished evidence packet from a prior
authorization agent. It is the real deliverable, not a mockup. A vendor would
hand you this file. You verify it yourself.

If you received a packet like this one and want to check it, read
[FOR-REVIEWERS.md](../../FOR-REVIEWERS.md) at the top of this repo. It walks the
one command and the pass and fail cases in plain language.

## Verify it now

You need Node 18 or newer. Nothing else. No account, no install.

```
unzip evidence.zip -d packet
node packet/verify.mjs
```

You should see every check pass and `All checks passed: 6 receipt(s), chain intact.`

## What is inside

- `receipts/` : six signed receipts, one per agent action.
- `plan.json` : the signed plan that said what the agent was allowed to do.
- `public_key.pem` : the key that lets you check every signature.
- `receipt_index.json` : a table of contents plus the chain summary.
- `verify.mjs` : the standalone checker. It uses only Node. It does not call home.

## The session it records

The agent worked one prior auth case under a signed plan.

1. It read the assigned patient's record. In scope.
2. It submitted a prior auth. The billed amount stayed within the authorized amount.
3. It tried to read a different patient's record. Out of scope, so it was blocked before it ran. The block is receipted.
4. It reached an appeal, which is held for a clinician.
5. A clinician approved the appeal. The approval is its own signed receipt.
6. The appeal was submitted under that approval.

## Regenerate it

This packet is produced deterministically by [generate.ts](generate.ts), so
the committed `evidence.zip` is byte for byte what the script writes.

```
npm run example:packet
```
