# The trial agent

The runnable companion to [TRY-IT.md](../../TRY-IT.md). One file that shows the
half-day trial end to end.

```
npm run example:trial
```

Part A wraps a toy prior auth agent with `harden()` in shadow mode. Every call
is recorded and nothing is blocked. Part B signs a plan and writes receipts to
`out/`, then prints the two commands that produce and verify a forwardable
evidence packet.

Nothing here leaves your machine. The receipts, the key, and the packet are all
written locally.
