# Note: what would make Eve better for instrumenting agents

**The one thing:** give Eve a single durable, decision-aware tool-interception
middleware — one `defineToolMiddleware(fn)` seam that hands the interceptor
(a) Eve's own cross-step durable state, (b) the resolved approval decision
(`granted`/`denied` + approver identity), and (c) the replay-dedup key Eve
already computes.

**Why:** durable execution and first-class human approvals are the two
capabilities only Eve has; exposing them to interceptors turns *"prove what your
agent did, and who allowed it"* into a built-in rather than a reverse-engineering
job. Today the AgentMint guard
([`examples/prior-auth-eve/agent/lib/agentmint.ts`](../examples/prior-auth-eve/agent/lib/agentmint.ts))
has to reconstruct all three by hand:

1. **State across steps** — Eve runs each tool call as an isolated durable step,
   so the guard hand-serializes the whole `RunState` into a `Snapshot`,
   rehydrates a Merkle tree from events before each `enforce`, and captures it
   back after (~150 lines re-deriving durability Eve already implements).
2. **Idempotency** — Eve replays completed steps but re-runs interrupted ones, so
   the guard invents a deterministic `eventKey` and a `results` map to dedupe, or
   receipts double-count and breakers misfire.
3. **The approval decision** — `approval: always()` runs *before* execute and the
   outcome is never handed down, so grants are faked as synthetic `held→approved`
   events and denials need a *separate* runtime-stream hook plus a `pending`
   stash. The single most audit-critical fact is reassembled from two
   disconnected places.

A decision-aware durable middleware collapses that file to a ~40-line adapter and
designs the idempotency/durability bugs out. It's also differentiating: the
stateless-callback frameworks (Vercel AI SDK, LangChain, Mastra) structurally
can't offer approval-bound, tamper-evident receipts — Eve's moat is exactly the
two things it currently keeps closed to instrumentation.
