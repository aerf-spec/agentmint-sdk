// @npmsai/agentmint/notary — the plan-bound AERF evidence layer.
//
// Guarantee: notary receipts bind each decision to a human-approved, signed
// plan and chain them per plan, so an auditor can verify — across independent
// implementations (this SDK, the Python producer, the Go verifier) — that a run
// stayed within an authorized policy and that no receipt was altered or removed.
//
// This is a subpath barrel over the root modules; it adds no new code. The wedge
// (harden → signed receipt → verify) lives at the package root; reach for this
// layer when you need signed plans, cross-implementation AERF receipts, per-plan
// chain verification, or a portable evidence bundle.
export * from "../notary.js";
export * from "../plan.js";
export * from "../receipt-aerf.js";
export * from "../evidence.js";
