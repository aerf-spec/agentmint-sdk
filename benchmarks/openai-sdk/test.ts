import { formatHarnessMarkdown, measureOverhead, runHarness, writeResultsFile, type HarnessScenario, type ToolMap } from "../shared.ts";

type OpenAITools = ToolMap;

const SPEC_YAML = `version: "1.0"
tools:
  lookup_account:
    requires: [lookup_user]
  issue_credit:
    requires: [lookup_account]
    input:
      properties:
        account_id:
          cross_ref: lookup_account.input.account_id
  handoff_billing:
    requires: [lookup_account]
  handoff_security:
    requires: [lookup_user]
  delete_account:
    action: block
  send_email:
    input:
      properties:
        to:
          blocked_patterns:
            - "*@external.com"
          action: block
breakers:
  loop:
    max_identical_calls: 3
  velocity:
    max_calls_per_window: 8
    window_seconds: 30
`;

function createTools(): OpenAITools {
  return {
    lookup_user: async (params) => ({ user_id: params.user_id }),
    lookup_account: async (params) => ({ account_id: params.account_id }),
    issue_credit: async (params) => ({ account_id: params.account_id, amount: params.amount }),
    handoff_billing: async () => ({ handed_off: "billing" }),
    handoff_security: async () => ({ handed_off: "security" }),
    delete_account: async (params) => ({ deleted: true, account_id: params.account_id }),
    send_email: async (params) => ({ sent: true, to: params.to }),
    summarize_case: async () => ({ ok: true }),
    open_ticket: async () => ({ ticket_id: "T-1" }),
  };
}

const scenarios: Array<HarnessScenario<OpenAITools>> = [
  { id: "P1", area: "Policy", name: "Credit without account lookup", expectedAgentMintCatch: true, runRaw: async (t) => { await t.issue_credit({ account_id: "A1", amount: 10 }); return { caught: false, details: "credit ran without lookup" }; }, runAgentMint: async (t) => { const r = await t.issue_credit({ account_id: "A1", amount: 10 }); return { caught: Boolean((r as any)?.error), details: "requires blocked" }; } },
  { id: "P2", area: "Policy", name: "Billing handoff without account", expectedAgentMintCatch: true, runRaw: async (t) => { await t.handoff_billing({ reason: "refund" }); return { caught: false, details: "handoff ran" }; }, runAgentMint: async (t) => { const r = await t.handoff_billing({ reason: "refund" }); return { caught: Boolean((r as any)?.error), details: "requires blocked" }; } },
  { id: "P3", area: "Policy", name: "Security handoff without user", expectedAgentMintCatch: true, runRaw: async (t) => { await t.handoff_security({ reason: "fraud" }); return { caught: false, details: "handoff ran" }; }, runAgentMint: async (t) => { const r = await t.handoff_security({ reason: "fraud" }); return { caught: Boolean((r as any)?.error), details: "requires blocked" }; } },
  { id: "P4", area: "Policy", name: "Correct handoff path", expectedAgentMintCatch: false, runRaw: async (t) => { await t.lookup_user({ user_id: "U1" }); await t.lookup_account({ account_id: "A1" }); await t.handoff_billing({ reason: "refund" }); return { caught: false, details: "healthy path" }; }, runAgentMint: async (t) => { await t.lookup_user({ user_id: "U1" }); await t.lookup_account({ account_id: "A1" }); await t.handoff_billing({ reason: "refund" }); return { caught: false, details: "healthy path stayed clean" }; } },
  { id: "P5", area: "Policy", name: "Ungoverned summary", expectedAgentMintCatch: false, runRaw: async (t) => { await t.summarize_case({}); return { caught: false, details: "ungoverned tool" }; }, runAgentMint: async (t) => { await t.summarize_case({}); return { caught: false, details: "no false positive" }; } },
  { id: "P6", area: "Policy", name: "Account lookup without user context", expectedAgentMintCatch: true, runRaw: async (t) => { await t.lookup_account({ account_id: "A1" }); return { caught: false, details: "lookup ran" }; }, runAgentMint: async (t) => { const r = await t.lookup_account({ account_id: "A1" }); return { caught: Boolean((r as any)?.error), details: "requires blocked" }; } },
  { id: "E1", area: "Enforcement", name: "Delete account", expectedAgentMintCatch: true, runRaw: async (t) => { await t.delete_account({ account_id: "A1" }); return { caught: false, details: "delete ran" }; }, runAgentMint: async (t) => { const r = await t.delete_account({ account_id: "A1" }); return { caught: Boolean((r as any)?.error), details: "blocked action" }; } },
  { id: "E2", area: "Enforcement", name: "External email", expectedAgentMintCatch: true, runRaw: async (t) => { await t.send_email({ to: "vip@external.com" }); return { caught: false, details: "email sent" }; }, runAgentMint: async (t) => { const r = await t.send_email({ to: "vip@external.com" }); return { caught: Boolean((r as any)?.error), details: "pattern blocked" }; } },
  { id: "E3", area: "Enforcement", name: "Account cross-ref mismatch", expectedAgentMintCatch: true, runRaw: async (t) => { await t.lookup_user({ user_id: "U1" }); await t.lookup_account({ account_id: "A1" }); await t.issue_credit({ account_id: "A9", amount: 10 }); return { caught: false, details: "wrong account used" }; }, runAgentMint: async (t) => { await t.lookup_user({ user_id: "U1" }); await t.lookup_account({ account_id: "A1" }); await t.issue_credit({ account_id: "A9", amount: 10 }); return { caught: t.__state().warnedCount > 0, details: "cross-ref warned" }; } },
  { id: "E4", area: "Enforcement", name: "Safe credit", expectedAgentMintCatch: false, runRaw: async (t) => { await t.lookup_user({ user_id: "U1" }); await t.lookup_account({ account_id: "A1" }); await t.issue_credit({ account_id: "A1", amount: 10 }); return { caught: false, details: "safe credit" }; }, runAgentMint: async (t) => { await t.lookup_user({ user_id: "U1" }); await t.lookup_account({ account_id: "A1" }); await t.issue_credit({ account_id: "A1", amount: 10 }); return { caught: false, details: "safe credit stayed clean" }; } },
  { id: "E5", area: "Enforcement", name: "Open ticket safe path", expectedAgentMintCatch: false, runRaw: async (t) => { await t.open_ticket({}); return { caught: false, details: "ticket opened" }; }, runAgentMint: async (t) => { await t.open_ticket({}); return { caught: false, details: "ungoverned safe tool" }; } },
  { id: "E6", area: "Enforcement", name: "Second external email", expectedAgentMintCatch: true, runRaw: async (t) => { await t.send_email({ to: "legal@external.com" }); return { caught: false, details: "email sent" }; }, runAgentMint: async (t) => { const r = await t.send_email({ to: "legal@external.com" }); return { caught: Boolean((r as any)?.error), details: "pattern blocked" }; } },
  { id: "A1", area: "Audit", name: "Clean trail", expectedAgentMintCatch: true, runRaw: async () => ({ caught: false, details: "no structured trail" }), runAgentMint: async (t) => { await t.lookup_user({ user_id: "U1" }); await t.lookup_account({ account_id: "A1" }); await t.issue_credit({ account_id: "A1", amount: 10 }); return { caught: t.__state().events.length >= 3, details: "events captured" }; } },
  { id: "A2", area: "Audit", name: "Blocked then allowed", expectedAgentMintCatch: true, runRaw: async () => ({ caught: false, details: "no structured trail" }), runAgentMint: async (t) => { await t.issue_credit({ account_id: "A1", amount: 10 }); await t.lookup_user({ user_id: "U1" }); await t.lookup_account({ account_id: "A1" }); await t.issue_credit({ account_id: "A1", amount: 10 }); return { caught: t.__state().events.some((e) => e.result === "blocked") && t.__state().events.some((e) => e.result === "allowed"), details: "blocked and allowed both present" }; } },
  { id: "A3", area: "Audit", name: "Fresh session", expectedAgentMintCatch: true, runRaw: async () => ({ caught: false, details: "no session model" }), runAgentMint: async (t) => { await t.lookup_user({ user_id: "U1" }); return { caught: t.__state().runId.startsWith("amr_"), details: "session metadata exists" }; } },
  { id: "B1", area: "Breakers", name: "Identical handoff loop", expectedAgentMintCatch: true, runRaw: async (t) => { for (let i = 0; i < 4; i++) await t.open_ticket({}); return { caught: false, details: "loop ran" }; }, runAgentMint: async (t) => { for (let i = 0; i < 4; i++) { const r = await t.open_ticket({}); if ((r as any)?.error) return { caught: true, details: "loop breaker tripped" }; } return { caught: false, details: "loop breaker missed" }; } },
  { id: "B2", area: "Breakers", name: "Different tickets", expectedAgentMintCatch: false, runRaw: async (t) => { await t.open_ticket({ id: 1 }); await t.open_ticket({ id: 2 }); await t.open_ticket({ id: 3 }); return { caught: false, details: "variation healthy" }; }, runAgentMint: async (t) => { await t.open_ticket({ id: 1 }); await t.open_ticket({ id: 2 }); await t.open_ticket({ id: 3 }); return { caught: false, details: "variation stayed healthy" }; } },
  { id: "B3", area: "Breakers", name: "Velocity burst", expectedAgentMintCatch: true, runRaw: async (t) => { for (const fn of [() => t.lookup_user({ user_id: "U1" }), () => t.lookup_account({ account_id: "A1" }), () => t.open_ticket({ id: 1 }), () => t.open_ticket({ id: 2 }), () => t.summarize_case({}), () => t.send_email({ to: "ops@example.com" }), () => t.handoff_security({ reason: "fraud" }), () => t.handoff_billing({ reason: "refund" }), () => t.lookup_user({ user_id: "U2" })]) await fn(); return { caught: false, details: "burst ran" }; }, runAgentMint: async (t) => { for (const fn of [() => t.lookup_user({ user_id: "U1" }), () => t.lookup_account({ account_id: "A1" }), () => t.open_ticket({ id: 1 }), () => t.open_ticket({ id: 2 }), () => t.summarize_case({}), () => t.send_email({ to: "ops@example.com" }), () => t.handoff_security({ reason: "fraud" }), () => t.handoff_billing({ reason: "refund" }), () => t.lookup_user({ user_id: "U2" })]) { const r = await fn(); if ((r as any)?.error) return { caught: true, details: "velocity tripped" }; } return { caught: false, details: "velocity missed" }; } },
  { id: "C1", area: "Clean Runs", name: "Healthy refund handoff", expectedAgentMintCatch: false, runRaw: async (t) => { await t.lookup_user({ user_id: "U1" }); await t.lookup_account({ account_id: "A1" }); await t.handoff_billing({ reason: "refund" }); return { caught: false, details: "healthy path" }; }, runAgentMint: async (t) => { await t.lookup_user({ user_id: "U1" }); await t.lookup_account({ account_id: "A1" }); await t.handoff_billing({ reason: "refund" }); return { caught: false, details: "healthy path clean" }; } },
  { id: "C2", area: "Clean Runs", name: "Healthy security handoff", expectedAgentMintCatch: false, runRaw: async (t) => { await t.lookup_user({ user_id: "U1" }); await t.handoff_security({ reason: "fraud" }); return { caught: false, details: "healthy path" }; }, runAgentMint: async (t) => { await t.lookup_user({ user_id: "U1" }); await t.handoff_security({ reason: "fraud" }); return { caught: false, details: "healthy path clean" }; } },
  { id: "X1", area: "Edge Cases", name: "Handoff gap visibility", expectedAgentMintCatch: true, runRaw: async (t) => { await t.handoff_billing({ reason: "manual refund" }); await t.issue_credit({ account_id: "A1", amount: 10 }); return { caught: false, details: "handoff did not enforce prerequisites" }; }, runAgentMint: async (t) => { await t.handoff_billing({ reason: "manual refund" }); const r = await t.issue_credit({ account_id: "A1", amount: 10 }); return { caught: Boolean((r as any)?.error), details: "handoff gap converted into an explicit block" }; } },
  { id: "L1", area: "Latency", name: "Overhead", expectedAgentMintCatch: false, runRaw: async () => ({ caught: false, details: "latency separate" }), runAgentMint: async () => ({ caught: false, details: "wrapper overhead only", latencyUs: await measureOverhead(createTools, "lookup_user", (i) => ({ user_id: `U${i}` })) }) },
];

async function main(): Promise<void> {
  const report = await runHarness({
    framework: "OpenAI SDK",
    specYaml: SPEC_YAML,
    rawToolsFactory: createTools,
    scenarios,
    reproduceCmd: "node --import tsx benchmarks/openai-sdk/test.ts",
    overview: [
      { property: "Policy enforcement", framework: "Tool calling and handoffs only", agentmint: "Prerequisite and cross-ref enforcement at the tool boundary", notSolved: "Planner quality and agent delegation strategy" },
      { property: "Destructive command blocking", framework: "None in raw tool execution", agentmint: "Blocked actions and outbound destinations from spec", notSolved: "Unwrapped side effects" },
      { property: "Structured audit trail", framework: "Partial tracing depending on app setup", agentmint: "Explicit allowed/warned/blocked event log", notSolved: "Trace interpretation" },
      { property: "Circuit breakers", framework: "None by default", agentmint: "Loop and velocity breakers", notSolved: "Long semantic drifts" },
    ],
  });
  const markdown = formatHarnessMarkdown(report);
  writeResultsFile(import.meta.url, markdown);
  console.log(markdown);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
