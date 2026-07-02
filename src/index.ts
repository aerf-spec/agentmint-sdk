// AgentMint SDK — cryptographic receipts for agent actions.
//
// This is the public surface. It exposes the wedge (wrap an agent action, get a
// signed receipt, verify it later) plus the two primary entry points every user
// imports: harden() and loadSpec(). Everything else in ./experimental and
// ./kernel is internal.

// harden — one-line auto-wrapper: instrument all your tools at once.
//          THE primary public API — `const tools = harden(myTools)`.
export { harden } from "./experimental/harden.js";

// loadSpec — load and normalize an agentmint.spec.yaml
export { loadSpec } from "./kernel/spec.js";

// receipt — build a signed, tamper-evident record of an agent action
export * from "./receipt.js";

// receipt-decision — signed, hash-chained receipts for individual decisions
export * from "./receipt-decision.js";

// verify — check a receipt or a chain of receipts against its claims
export * from "./verify.js";

// gate — pre-flight approval check before an action runs
export * from "./gate.js";

// session — group receipts into an auditable, ordered session
export * from "./session.js";

// log — build run state and emit block/violation events
export * from "./log.js";

// merkle — hashing + Merkle tree used to chain and prove receipts
export * from "./merkle.js";

// jsonl — serialize/parse receipts as append-only JSONL evidence
export * from "./jsonl.js";

// types — shared type definitions for the SDK surface
export * from "./types.js";
