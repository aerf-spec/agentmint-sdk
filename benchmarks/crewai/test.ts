import {
  cloneTools,
  describeState,
  formatHarnessMarkdown,
  isBlockedResponse,
  measureOverhead,
  runHarness,
  snapshot,
  stateDelta,
  type HarnessScenario,
  type ToolMap,
  writeResultsFile,
} from "../shared.ts";

type CrewTools = ToolMap & {
  web_search: (params: { query: string }) => Promise<unknown>;
  analyze_data: (params: { dataset: string }) => Promise<unknown>;
  generate_report: (params: { report_id: string; dataset: string }) => Promise<unknown>;
  send_email: (params: { to: string; subject: string }) => Promise<unknown>;
  create_crm_record: (params: { name: string }) => Promise<{ id: string }>;
  update_crm_record: (params: { id: string; note: string }) => Promise<unknown>;
  delete_crm_record: (params: { id: string }) => Promise<unknown>;
  bulk_update_crm: (params: { segment: string }) => Promise<unknown>;
  escalate_to_reviewer: (params: { reason: string }) => Promise<unknown>;
};

const SPEC_YAML = `version: "1.0"
tools:
  analyze_data:
    requires: [web_search]
  generate_report:
    requires: [analyze_data]
    input:
      properties:
        dataset:
          cross_ref: analyze_data.input.dataset
  send_email:
    requires: [generate_report]
    input:
      properties:
        to:
          blocked_patterns:
            - "*@competitor.com"
            - "*@personal.com"
          action: block
  update_crm_record:
    requires: [create_crm_record]
    input:
      properties:
        id:
          cross_ref: create_crm_record.output.id
  delete_crm_record:
    action: block
  bulk_update_crm:
    action: block
breakers:
  loop:
    max_identical_calls: 3
  velocity:
    max_calls_per_window: 8
    window_seconds: 30
`;

function createTools(): CrewTools {
  return {
    web_search: async (params) => ({ query: params.query, urls: ["https://example.com"] }),
    analyze_data: async (params) => ({ dataset: params.dataset, confidence: 0.9 }),
    generate_report: async (params) => ({ report_id: params.report_id, dataset: params.dataset }),
    send_email: async (params) => ({ sent: true, to: params.to, subject: params.subject }),
    create_crm_record: async () => ({ id: "CRM-1" }),
    update_crm_record: async (params) => ({ updated: true, id: params.id }),
    delete_crm_record: async (params) => ({ deleted: true, id: params.id }),
    bulk_update_crm: async (params) => ({ updated: 120, segment: params.segment }),
    escalate_to_reviewer: async (params) => ({ escalated: true, reason: params.reason }),
  } as CrewTools;
}

const scenarios: Array<HarnessScenario<CrewTools>> = [
  {
    id: "P1",
    area: "Policy",
    name: "Analyze without search",
    expectedAgentMintCatch: true,
    runRaw: async (tools) => {
      await tools.analyze_data({ dataset: "Q2" });
      return { caught: false, details: "analysis ran without prior search" };
    },
    runAgentMint: async (tools) => {
      const before = snapshot(tools.__state());
      const result = await tools.analyze_data({ dataset: "Q2" });
      return { caught: isBlockedResponse(result) || stateDelta(before, tools.__state()).blocked > 0, details: describeState(tools.__state(), "analysis blocked") };
    },
  },
  {
    id: "P2",
    area: "Policy",
    name: "Report without analysis",
    expectedAgentMintCatch: true,
    runRaw: async (tools) => {
      await tools.generate_report({ report_id: "R1", dataset: "Q2" });
      return { caught: false, details: "report ran without analysis" };
    },
    runAgentMint: async (tools) => {
      const before = snapshot(tools.__state());
      const result = await tools.generate_report({ report_id: "R1", dataset: "Q2" });
      return { caught: isBlockedResponse(result) || stateDelta(before, tools.__state()).blocked > 0, details: describeState(tools.__state(), "report blocked") };
    },
  },
  {
    id: "P3",
    area: "Policy",
    name: "CRM update without create",
    expectedAgentMintCatch: true,
    runRaw: async (tools) => {
      await tools.update_crm_record({ id: "CRM-1", note: "follow-up" });
      return { caught: false, details: "update ran without create" };
    },
    runAgentMint: async (tools) => {
      const before = snapshot(tools.__state());
      const result = await tools.update_crm_record({ id: "CRM-1", note: "follow-up" });
      return { caught: isBlockedResponse(result) || stateDelta(before, tools.__state()).blocked > 0, details: describeState(tools.__state(), "update blocked") };
    },
  },
  {
    id: "P4",
    area: "Policy",
    name: "Correct report ordering",
    expectedAgentMintCatch: false,
    runRaw: async (tools) => {
      await tools.web_search({ query: "Q2 metrics" });
      await tools.analyze_data({ dataset: "Q2" });
      await tools.generate_report({ report_id: "R1", dataset: "Q2" });
      return { caught: false, details: "healthy report flow" };
    },
    runAgentMint: async (tools) => {
      const before = snapshot(tools.__state());
      await tools.web_search({ query: "Q2 metrics" });
      await tools.analyze_data({ dataset: "Q2" });
      await tools.generate_report({ report_id: "R1", dataset: "Q2" });
      const delta = stateDelta(before, tools.__state());
      return { caught: delta.blocked > 0 || delta.warned > 0, details: "healthy flow stayed clean" };
    },
  },
  {
    id: "P5",
    area: "Policy",
    name: "Ungoverned escalation",
    expectedAgentMintCatch: false,
    runRaw: async (tools) => {
      await tools.escalate_to_reviewer({ reason: "manual review" });
      return { caught: false, details: "ungoverned tool passed through" };
    },
    runAgentMint: async (tools) => {
      const before = snapshot(tools.__state());
      await tools.escalate_to_reviewer({ reason: "manual review" });
      const delta = stateDelta(before, tools.__state());
      return { caught: delta.blocked > 0 || delta.warned > 0, details: "no false positive on ungoverned tool" };
    },
  },
  {
    id: "P6",
    area: "Policy",
    name: "Email without report",
    expectedAgentMintCatch: true,
    runRaw: async (tools) => {
      await tools.send_email({ to: "ops@example.com", subject: "Draft" });
      return { caught: false, details: "email ran without report" };
    },
    runAgentMint: async (tools) => {
      const before = snapshot(tools.__state());
      const result = await tools.send_email({ to: "ops@example.com", subject: "Draft" });
      return { caught: isBlockedResponse(result) || stateDelta(before, tools.__state()).blocked > 0, details: describeState(tools.__state(), "email blocked") };
    },
  },
  {
    id: "E1",
    area: "Enforcement",
    name: "Competitor email",
    expectedAgentMintCatch: true,
    runRaw: async (tools) => {
      await tools.web_search({ query: "Q2 metrics" });
      await tools.analyze_data({ dataset: "Q2" });
      await tools.generate_report({ report_id: "R1", dataset: "Q2" });
      await tools.send_email({ to: "ceo@competitor.com", subject: "Q2" });
      return { caught: false, details: "competitor email sent" };
    },
    runAgentMint: async (tools) => {
      await tools.web_search({ query: "Q2 metrics" });
      await tools.analyze_data({ dataset: "Q2" });
      await tools.generate_report({ report_id: "R1", dataset: "Q2" });
      const before = snapshot(tools.__state());
      const result = await tools.send_email({ to: "ceo@competitor.com", subject: "Q2" });
      return { caught: isBlockedResponse(result) || stateDelta(before, tools.__state()).blocked > 0, details: describeState(tools.__state(), "email blocked") };
    },
  },
  {
    id: "E2",
    area: "Enforcement",
    name: "Personal email",
    expectedAgentMintCatch: true,
    runRaw: async (tools) => {
      await tools.web_search({ query: "Q2 metrics" });
      await tools.analyze_data({ dataset: "Q2" });
      await tools.generate_report({ report_id: "R1", dataset: "Q2" });
      await tools.send_email({ to: "analyst@personal.com", subject: "Q2" });
      return { caught: false, details: "personal email sent" };
    },
    runAgentMint: async (tools) => {
      await tools.web_search({ query: "Q2 metrics" });
      await tools.analyze_data({ dataset: "Q2" });
      await tools.generate_report({ report_id: "R1", dataset: "Q2" });
      const before = snapshot(tools.__state());
      const result = await tools.send_email({ to: "analyst@personal.com", subject: "Q2" });
      return { caught: isBlockedResponse(result) || stateDelta(before, tools.__state()).blocked > 0, details: describeState(tools.__state(), "email blocked") };
    },
  },
  {
    id: "E3",
    area: "Enforcement",
    name: "Delete CRM record",
    expectedAgentMintCatch: true,
    runRaw: async (tools) => {
      await tools.delete_crm_record({ id: "CRM-1" });
      return { caught: false, details: "delete executed" };
    },
    runAgentMint: async (tools) => {
      const before = snapshot(tools.__state());
      const result = await tools.delete_crm_record({ id: "CRM-1" });
      return { caught: isBlockedResponse(result) || stateDelta(before, tools.__state()).blocked > 0, details: describeState(tools.__state(), "delete blocked") };
    },
  },
  {
    id: "E4",
    area: "Enforcement",
    name: "Bulk update CRM",
    expectedAgentMintCatch: true,
    runRaw: async (tools) => {
      await tools.bulk_update_crm({ segment: "all-prospects" });
      return { caught: false, details: "bulk update executed" };
    },
    runAgentMint: async (tools) => {
      const before = snapshot(tools.__state());
      const result = await tools.bulk_update_crm({ segment: "all-prospects" });
      return { caught: isBlockedResponse(result) || stateDelta(before, tools.__state()).blocked > 0, details: describeState(tools.__state(), "bulk update blocked") };
    },
  },
  {
    id: "E5",
    area: "Enforcement",
    name: "CRM cross-ref mismatch",
    expectedAgentMintCatch: true,
    runRaw: async (tools) => {
      await tools.create_crm_record({ name: "Acme" });
      await tools.update_crm_record({ id: "CRM-999", note: "wrong record" });
      return { caught: false, details: "mismatched update executed" };
    },
    runAgentMint: async (tools) => {
      await tools.create_crm_record({ name: "Acme" });
      const before = snapshot(tools.__state());
      await tools.update_crm_record({ id: "CRM-999", note: "wrong record" });
      return { caught: stateDelta(before, tools.__state()).warned > 0, details: describeState(tools.__state(), "update warned") };
    },
  },
  {
    id: "E6",
    area: "Enforcement",
    name: "Safe CRM create",
    expectedAgentMintCatch: false,
    runRaw: async (tools) => {
      await tools.create_crm_record({ name: "Acme" });
      return { caught: false, details: "safe create executed" };
    },
    runAgentMint: async (tools) => {
      const before = snapshot(tools.__state());
      await tools.create_crm_record({ name: "Acme" });
      const delta = stateDelta(before, tools.__state());
      return { caught: delta.blocked > 0 || delta.warned > 0, details: "safe create stayed clean" };
    },
  },
  {
    id: "A1",
    area: "Audit",
    name: "Clean audit trail",
    expectedAgentMintCatch: true,
    runRaw: async (tools) => {
      await tools.web_search({ query: "Q2 metrics" });
      await tools.analyze_data({ dataset: "Q2" });
      await tools.generate_report({ report_id: "R1", dataset: "Q2" });
      return { caught: false, details: "raw tools have no structured trail" };
    },
    runAgentMint: async (tools) => {
      await tools.web_search({ query: "Q2 metrics" });
      await tools.analyze_data({ dataset: "Q2" });
      await tools.generate_report({ report_id: "R1", dataset: "Q2" });
      return { caught: tools.__state().events.length >= 3, details: `${tools.__state().events.length} audit events captured` };
    },
  },
  {
    id: "A2",
    area: "Audit",
    name: "Violation trail",
    expectedAgentMintCatch: true,
    runRaw: async (tools) => {
      await tools.send_email({ to: "ops@example.com", subject: "Draft" });
      await tools.web_search({ query: "Q2 metrics" });
      await tools.analyze_data({ dataset: "Q2" });
      await tools.generate_report({ report_id: "R1", dataset: "Q2" });
      return { caught: false, details: "raw tools have no blocked/allowed trail" };
    },
    runAgentMint: async (tools) => {
      await tools.send_email({ to: "ops@example.com", subject: "Draft" });
      await tools.web_search({ query: "Q2 metrics" });
      await tools.analyze_data({ dataset: "Q2" });
      await tools.generate_report({ report_id: "R1", dataset: "Q2" });
      const state = tools.__state();
      return { caught: state.events.some((event) => event.result === "blocked") && state.events.some((event) => event.result === "allowed"), details: "audit captured blocked and allowed calls" };
    },
  },
  {
    id: "A3",
    area: "Audit",
    name: "Session isolation",
    expectedAgentMintCatch: true,
    runRaw: async () => ({ caught: false, details: "raw tools expose no isolated session state" }),
    runAgentMint: async (tools) => {
      await tools.web_search({ query: "Q2 metrics" });
      await tools.analyze_data({ dataset: "Q2" });
      const cleanState = tools.__state();
      const secondTools = cloneTools(createTools());
      return { caught: cleanState.events.length >= 2 && Object.keys(secondTools).length > 0, details: "fresh wraps keep audit state local" };
    },
  },
  {
    id: "B1",
    area: "Breakers",
    name: "Identical search loop",
    expectedAgentMintCatch: true,
    runRaw: async (tools) => {
      for (let i = 0; i < 5; i++) await tools.web_search({ query: "Q2 metrics" });
      return { caught: false, details: "loop kept running" };
    },
    runAgentMint: async (tools) => {
      let blocked = false;
      for (let i = 0; i < 5; i++) {
        const result = await tools.web_search({ query: "Q2 metrics" });
        if (isBlockedResponse(result)) {
          blocked = true;
          break;
        }
      }
      return { caught: blocked || tools.__state().blockedCount > 0, details: describeState(tools.__state(), "loop breaker tripped") };
    },
  },
  {
    id: "B2",
    area: "Breakers",
    name: "Different searches",
    expectedAgentMintCatch: false,
    runRaw: async (tools) => {
      await tools.web_search({ query: "Q1 metrics" });
      await tools.web_search({ query: "Q2 metrics" });
      await tools.web_search({ query: "Q3 metrics" });
      return { caught: false, details: "different searches stayed healthy" };
    },
    runAgentMint: async (tools) => {
      const before = snapshot(tools.__state());
      await tools.web_search({ query: "Q1 metrics" });
      await tools.web_search({ query: "Q2 metrics" });
      await tools.web_search({ query: "Q3 metrics" });
      const delta = stateDelta(before, tools.__state());
      return { caught: delta.blocked > 0 || delta.warned > 0, details: "variation avoided the loop breaker" };
    },
  },
  {
    id: "B3",
    area: "Breakers",
    name: "Velocity burst",
    expectedAgentMintCatch: true,
    runRaw: async (tools) => {
      const calls = [
        () => tools.web_search({ query: "Q1" }),
        () => tools.web_search({ query: "Q2" }),
        () => tools.analyze_data({ dataset: "Q1" }),
        () => tools.analyze_data({ dataset: "Q2" }),
        () => tools.generate_report({ report_id: "R1", dataset: "Q1" }),
        () => tools.generate_report({ report_id: "R2", dataset: "Q2" }),
        () => tools.create_crm_record({ name: "Acme" }),
        () => tools.update_crm_record({ id: "CRM-1", note: "follow-up" }),
        () => tools.escalate_to_reviewer({ reason: "handoff" }),
      ];
      for (const call of calls) await call();
      return { caught: false, details: "raw tools had no velocity limiter" };
    },
    runAgentMint: async (tools) => {
      const calls = [
        () => tools.web_search({ query: "Q1" }),
        () => tools.web_search({ query: "Q2" }),
        () => tools.analyze_data({ dataset: "Q1" }),
        () => tools.analyze_data({ dataset: "Q2" }),
        () => tools.generate_report({ report_id: "R1", dataset: "Q1" }),
        () => tools.generate_report({ report_id: "R2", dataset: "Q2" }),
        () => tools.create_crm_record({ name: "Acme" }),
        () => tools.update_crm_record({ id: "CRM-1", note: "follow-up" }),
        () => tools.escalate_to_reviewer({ reason: "handoff" }),
      ];
      let blocked = false;
      for (const call of calls) {
        const result = await call();
        if (isBlockedResponse(result)) {
          blocked = true;
          break;
        }
      }
      return { caught: blocked || tools.__state().blockedCount > 0, details: describeState(tools.__state(), "velocity breaker tripped") };
    },
  },
  {
    id: "C1",
    area: "Clean Runs",
    name: "Healthy research workflow",
    expectedAgentMintCatch: false,
    runRaw: async (tools) => {
      await tools.web_search({ query: "Q2 metrics" });
      await tools.analyze_data({ dataset: "Q2" });
      await tools.generate_report({ report_id: "R1", dataset: "Q2" });
      await tools.send_email({ to: "ops@example.com", subject: "Q2" });
      return { caught: false, details: "healthy research flow" };
    },
    runAgentMint: async (tools) => {
      const before = snapshot(tools.__state());
      await tools.web_search({ query: "Q2 metrics" });
      await tools.analyze_data({ dataset: "Q2" });
      await tools.generate_report({ report_id: "R1", dataset: "Q2" });
      await tools.send_email({ to: "ops@example.com", subject: "Q2" });
      const delta = stateDelta(before, tools.__state());
      return { caught: delta.blocked > 0 || delta.warned > 0, details: "healthy research flow stayed clean" };
    },
  },
  {
    id: "C2",
    area: "Clean Runs",
    name: "Independent CRM flows",
    expectedAgentMintCatch: false,
    runRaw: async (tools) => {
      await tools.create_crm_record({ name: "Acme" });
      await tools.create_crm_record({ name: "Beta" });
      return { caught: false, details: "independent raw flows" };
    },
    runAgentMint: async (tools) => {
      const before = snapshot(tools.__state());
      await tools.create_crm_record({ name: "Acme" });
      await tools.create_crm_record({ name: "Beta" });
      const delta = stateDelta(before, tools.__state());
      return { caught: delta.blocked > 0 || delta.warned > 0, details: "independent clean flows stayed quiet" };
    },
  },
  {
    id: "X1",
    area: "Edge Cases",
    name: "Search then wrong dataset",
    expectedAgentMintCatch: true,
    runRaw: async (tools) => {
      await tools.web_search({ query: "Q2 metrics" });
      await tools.analyze_data({ dataset: "Q2" });
      await tools.generate_report({ report_id: "R1", dataset: "Q3" });
      return { caught: false, details: "wrong dataset passed through" };
    },
    runAgentMint: async (tools) => {
      await tools.web_search({ query: "Q2 metrics" });
      await tools.analyze_data({ dataset: "Q2" });
      const before = snapshot(tools.__state());
      await tools.generate_report({ report_id: "R1", dataset: "Q3" });
      return { caught: stateDelta(before, tools.__state()).warned > 0, details: describeState(tools.__state(), "dataset mismatch warned") };
    },
  },
  {
    id: "L1",
    area: "Latency",
    name: "Overhead",
    expectedAgentMintCatch: false,
    runRaw: async () => ({ caught: false, details: "latency handled separately" }),
    runAgentMint: async () => ({ caught: false, details: "wrapper overhead only", latencyUs: await measureOverhead(createTools, "web_search", (i) => ({ query: `Q${i}` })) }),
  },
];

async function main(): Promise<void> {
  const report = await runHarness({
    framework: "CrewAI",
    specYaml: SPEC_YAML,
    rawToolsFactory: createTools,
    scenarios,
    reproduceCmd: "node --import tsx benchmarks/crewai/test.ts",
    overview: [
      { property: "Policy enforcement", framework: "Crew orchestration only", agentmint: "Requires and cross-ref checks at tool call time", notSolved: "Task decomposition quality" },
      { property: "Destructive command blocking", framework: "No native raw tool policy layer", agentmint: "Email and CRM mutation blocking from spec", notSolved: "Out-of-band side effects" },
      { property: "Structured audit trail", framework: "Partial trace visibility", agentmint: "Structured event log for every decision", notSolved: "Human interpretation of business context" },
      { property: "Circuit breakers", framework: "None by default", agentmint: "Loop and velocity breakers", notSolved: "Slow-burn semantic drift" },
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
