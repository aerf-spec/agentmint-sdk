import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import {
  END,
  MemorySaver,
  MessagesZodState,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { harden, loadSpec } from "@npmsai/agentmint";
import type { Event, RunState } from "@npmsai/agentmint";
import { z } from "zod";

type Category =
  | "policy"
  | "enforcement"
  | "audit"
  | "breaker"
  | "clean"
  | "edge"
  | "latency";

interface TestResult {
  name: string;
  category: Category;
  framework_result: string;
  agentmint_result: string;
  framework_caught: boolean;
  agentmint_caught: boolean;
  agentmint_false_positive: boolean;
  notes: string;
}

type RawTools = ReturnType<typeof createRawTools>;
type ToolName = keyof RawTools;

interface ToolCallOutcome {
  tool: ToolName;
  args: Record<string, unknown>;
  status: "success" | "error";
  content: unknown;
  blocked: boolean;
  warned: boolean;
  caught: boolean;
  events: Event[];
}

const SPEC_YAML = `
version: "1.0"
tools:
  issue_refund:
    requires: [lookup_order]
    input:
      properties:
        amount:
          max_ref: lookup_order.output.total
        order_id:
          cross_ref: lookup_order.input.order_id
  send_notification:
    requires: [lookup_customer]
    input:
      properties:
        customer_id:
          cross_ref: lookup_customer.input.customer_id
  delete_order:
    action: block
breakers:
  loop:
    max_identical_calls: 3
  velocity:
    max_calls_per_window: 10
    window_seconds: 30
`;

const LATENCY_SPEC_YAML = `version: "1.0"`;
const spec = loadSpec(SPEC_YAML);
const latencySpec = loadSpec(LATENCY_SPEC_YAML);

const schemas: Record<ToolName, z.ZodTypeAny> = {
  lookup_order: z.object({ order_id: z.string() }),
  lookup_customer: z.object({ customer_id: z.string() }),
  issue_refund: z.object({
    order_id: z.string(),
    amount: z.number(),
    reason: z.string(),
  }),
  update_order_status: z.object({
    order_id: z.string(),
    status: z.string(),
  }),
  send_notification: z.object({
    customer_id: z.string(),
    message: z.string(),
  }),
  delete_order: z.object({ order_id: z.string() }),
  transfer_to_supervisor: z.object({ reason: z.string() }),
};

const descriptions: Record<ToolName, string> = {
  lookup_order: "Look up order details by order ID.",
  lookup_customer: "Look up customer details by customer ID.",
  issue_refund: "Issue a refund for an order.",
  update_order_status: "Update an order status.",
  send_notification: "Send a notification to a customer.",
  delete_order: "Delete an order.",
  transfer_to_supervisor: "Transfer the case to a supervisor.",
};

function createRawTools() {
  return {
    lookup_order: async (p: { order_id: string }) => ({
      order_id: p.order_id,
      customer_id: "CUST-1",
      total: 49.99,
      status: "delivered",
      items: ["Widget Pro"],
    }),
    lookup_customer: async (p: { customer_id: string }) => ({
      customer_id: p.customer_id,
      name: "Alice",
      email: "alice@acme.com",
      tier: "gold",
    }),
    issue_refund: async (p: {
      order_id: string;
      amount: number;
      reason: string;
    }) => ({
      refund_id: `REF-${Date.now()}`,
      amount: p.amount,
      order_id: p.order_id,
    }),
    update_order_status: async (p: { order_id: string; status: string }) => ({
      error: "temporary failure, please retry",
      order_id: p.order_id,
      attempted_status: p.status,
    }),
    send_notification: async (p: {
      customer_id: string;
      message: string;
    }) => ({
      sent: true,
      to: p.customer_id,
      channel: "email",
      preview: p.message,
    }),
    delete_order: async (p: { order_id: string }) => ({
      deleted: true,
      order_id: p.order_id,
    }),
    transfer_to_supervisor: async (p: { reason: string }) => ({
      transferred: true,
      supervisor: "SUP-1",
      reason: p.reason,
    }),
  };
}

function parseToolContent(content: unknown): unknown {
  if (typeof content !== "string") {
    return content;
  }
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function summarizeValue(value: unknown, max = 80): string {
  const text =
    typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function summarizeEvents(events: Event[]): string {
  if (events.length === 0) {
    return "no AgentMint events";
  }
  return events
    .map((event) => {
      const base = `${event.result}:${event.tool}`;
      return event.reason ? `${base}/${event.reason}` : base;
    })
    .join(", ");
}

function summarizeOutcome(outcome: ToolCallOutcome): string {
  const status =
    outcome.status === "error"
      ? "schema_error"
      : outcome.blocked
        ? "blocked"
        : outcome.warned
          ? "warned"
          : "allowed";
  return `${outcome.tool} ${status} ${summarizeValue(outcome.content)}`;
}

function summarizeSequence(outcomes: ToolCallOutcome[]): string {
  return outcomes.map(summarizeOutcome).join(" | ");
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * p) - 1),
  );
  return sorted[index] ?? 0;
}

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function mkAiMessage(
  toolName: ToolName,
  args: Record<string, unknown>,
  id: string,
) {
  return new AIMessage({
    content: "",
    tool_calls: [
      {
        name: toolName,
        args,
        id,
        type: "tool_call",
      },
    ],
  });
}

class ScenarioEnv {
  private callCounter = 0;
  private readonly toolNode: ToolNode;
  private readonly runtimeTools:
    | RawTools
    | (RawTools & {
        __state(): RunState;
      });

  constructor(private readonly mode: "framework" | "agentmint") {
    const rawTools = createRawTools();
    this.runtimeTools =
      mode === "agentmint"
        ? (harden(rawTools, { spec, silent: true }) as RawTools & {
            __state(): RunState;
          })
        : rawTools;

    this.toolNode = new ToolNode(
      (Object.keys(schemas) as ToolName[]).map((name) =>
        tool(
          async (input) =>
            (this.runtimeTools[name] as (args: Record<string, unknown>) => Promise<unknown>)(
              input as Record<string, unknown>,
            ),
          {
            name,
            description: descriptions[name],
            schema: schemas[name],
          },
        ),
      ),
    );
  }

  getState(): RunState | null {
    if (this.mode !== "agentmint") {
      return null;
    }
    return (this.runtimeTools as RawTools & { __state(): RunState }).__state();
  }

  async call(
    toolName: ToolName,
    args: Record<string, unknown>,
  ): Promise<ToolCallOutcome> {
    const beforeEvents = this.getState()?.events.length ?? 0;
    const callId = `${this.mode}-${++this.callCounter}`;
    const result = (await this.toolNode.invoke({
      messages: [mkAiMessage(toolName, args, callId)],
    })) as { messages: ToolMessage[] };
    const message = result.messages[0];
    const content = parseToolContent(message.content);
    const newEvents = this.getState()?.events.slice(beforeEvents) ?? [];
    const blocked =
      (typeof content === "object" &&
        content !== null &&
        "error" in content &&
        (content as { error?: unknown }).error === true) ||
      newEvents.some((event) => event.result === "blocked");
    const warned = newEvents.some((event) => event.result === "warned");
    const status = message.status === "error" ? "error" : "success";
    return {
      tool: toolName,
      args,
      status,
      content,
      blocked,
      warned,
      caught: status === "error" || blocked || warned,
      events: newEvents,
    };
  }
}

async function sleep(ms: number) {
  await new Promise((resolveTimer) => setTimeout(resolveTimer, ms));
}

async function runFrameworkAudit(
  sequence: Array<{ tool: ToolName; args: Record<string, unknown> }>,
) {
  const rawTools = createRawTools();
  const graphTools = (Object.keys(schemas) as ToolName[]).map((name) =>
    tool(
      async (input) =>
        (rawTools[name] as (args: Record<string, unknown>) => Promise<unknown>)(
          input as Record<string, unknown>,
        ),
      {
        name,
        description: descriptions[name],
        schema: schemas[name],
      },
    ),
  );
  const graph = new StateGraph(MessagesZodState)
    .addNode("tools", new ToolNode(graphTools))
    .addEdge(START, "tools")
    .addEdge("tools", END)
    .compile({ checkpointer: new MemorySaver() });

  const threadId = randomId("audit");
  const config = {
    configurable: {
      thread_id: threadId,
    },
    streamMode: ["values", "tools"] as Array<"values" | "tools">,
  };

  let messages: any[] = [];
  const toolStreamEvents: unknown[] = [];

  for (let i = 0; i < sequence.length; i += 1) {
    const step = sequence[i]!;
    messages = [...messages, mkAiMessage(step.tool, step.args, `audit-${i + 1}`)];
    const stream = await graph.stream({ messages }, config);
    for await (const chunk of stream) {
      if (Array.isArray(chunk) && chunk[0] === "tools") {
        toolStreamEvents.push(chunk[1]);
      }
      if (Array.isArray(chunk) && chunk[0] === "values") {
        const values = chunk[1] as { messages?: unknown[] };
        if (values.messages) {
          messages = values.messages;
        }
      }
    }
  }

  const history: unknown[] = [];
  for await (const snapshot of graph.getStateHistory({
    configurable: { thread_id: threadId },
  })) {
    history.push(snapshot);
  }

  const historyText = JSON.stringify(history);
  return {
    toolStreamEvents,
    historyCount: history.length,
    createdAtPresent: historyText.includes("createdAt"),
    argsInHistory: historyText.includes("tool_calls") && historyText.includes("order_id"),
    resultsInHistory:
      historyText.includes("ToolMessage") || historyText.includes("refund_id"),
    policyFieldPresent:
      historyText.includes("policy") || historyText.includes("reason"),
    sampleToolEvent: toolStreamEvents[0] ?? null,
  };
}

function buildResult(args: {
  name: string;
  category: Category;
  expectedViolation: boolean;
  frameworkResult: string;
  agentmintResult: string;
  frameworkCaught: boolean;
  agentmintCaught: boolean;
  notes: string;
}): TestResult {
  return {
    name: args.name,
    category: args.category,
    framework_result: args.frameworkResult,
    agentmint_result: args.agentmintResult,
    framework_caught: args.frameworkCaught,
    agentmint_caught: args.agentmintCaught,
    agentmint_false_positive: !args.expectedViolation && args.agentmintCaught,
    notes: args.notes,
  };
}

async function runAllScenarios(): Promise<{
  results: TestResult[];
  latency: {
    baseline: { average: number; p50: number; p99: number };
    agentmint: { average: number; p50: number; p99: number };
    overheadMs: number;
    overheadPct: number;
  };
}> {
  const results: TestResult[] = [];

  {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const [fw, am] = await Promise.all([
      framework.call("issue_refund", {
        order_id: "ORD-1",
        amount: 30,
        reason: "broken",
      }),
      agentmint.call("issue_refund", {
        order_id: "ORD-1",
        amount: 30,
        reason: "broken",
      }),
    ]);
    results.push(
      buildResult({
        name: "P1 Refund without lookup",
        category: "policy",
        expectedViolation: true,
        frameworkResult: summarizeOutcome(fw),
        agentmintResult: summarizeOutcome(am),
        frameworkCaught: fw.caught,
        agentmintCaught: am.caught,
        notes: `AgentMint events: ${summarizeEvents(am.events)}`,
      }),
    );
  }

  {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const [fw, am] = await Promise.all([
      framework.call("send_notification", {
        customer_id: "CUST-1",
        message: "hi",
      }),
      agentmint.call("send_notification", {
        customer_id: "CUST-1",
        message: "hi",
      }),
    ]);
    results.push(
      buildResult({
        name: "P2 Notification without customer lookup",
        category: "policy",
        expectedViolation: true,
        frameworkResult: summarizeOutcome(fw),
        agentmintResult: summarizeOutcome(am),
        frameworkCaught: fw.caught,
        agentmintCaught: am.caught,
        notes: `AgentMint events: ${summarizeEvents(am.events)}`,
      }),
    );
  }

  {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const fwSeq = [
      await framework.call("lookup_order", { order_id: "ORD-1" }),
      await framework.call("issue_refund", {
        order_id: "ORD-1",
        amount: 30,
        reason: "broken",
      }),
    ];
    const amSeq = [
      await agentmint.call("lookup_order", { order_id: "ORD-1" }),
      await agentmint.call("issue_refund", {
        order_id: "ORD-1",
        amount: 30,
        reason: "broken",
      }),
    ];
    results.push(
      buildResult({
        name: "P3 Correct ordering",
        category: "policy",
        expectedViolation: false,
        frameworkResult: summarizeSequence(fwSeq),
        agentmintResult: summarizeSequence(amSeq),
        frameworkCaught: fwSeq.some((item) => item.caught),
        agentmintCaught: amSeq.some((item) => item.caught),
        notes: `AgentMint events: ${summarizeEvents(amSeq.flatMap((item) => item.events))}`,
      }),
    );
  }

  {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const fwSeq = [
      await framework.call("lookup_customer", { customer_id: "CUST-1" }),
      await framework.call("issue_refund", {
        order_id: "ORD-1",
        amount: 30,
        reason: "broken",
      }),
    ];
    const amSeq = [
      await agentmint.call("lookup_customer", { customer_id: "CUST-1" }),
      await agentmint.call("issue_refund", {
        order_id: "ORD-1",
        amount: 30,
        reason: "broken",
      }),
    ];
    results.push(
      buildResult({
        name: "P4 Partial ordering",
        category: "policy",
        expectedViolation: true,
        frameworkResult: summarizeSequence(fwSeq),
        agentmintResult: summarizeSequence(amSeq),
        frameworkCaught: fwSeq.some((item) => item.caught),
        agentmintCaught: amSeq.some((item) => item.caught),
        notes: `AgentMint events: ${summarizeEvents(amSeq.flatMap((item) => item.events))}`,
      }),
    );
  }

  {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const fwSeq = [
      await framework.call("lookup_order", { order_id: "ORD-1" }),
      await framework.call("issue_refund", {
        order_id: "ORD-1",
        amount: 200,
        reason: "broken",
      }),
    ];
    const amSeq = [
      await agentmint.call("lookup_order", { order_id: "ORD-1" }),
      await agentmint.call("issue_refund", {
        order_id: "ORD-1",
        amount: 200,
        reason: "broken",
      }),
    ];
    results.push(
      buildResult({
        name: "E1 Amount exceeds total",
        category: "enforcement",
        expectedViolation: true,
        frameworkResult: summarizeSequence(fwSeq),
        agentmintResult: summarizeSequence(amSeq),
        frameworkCaught: fwSeq.some((item) => item.caught),
        agentmintCaught: amSeq.some((item) => item.caught),
        notes: `AgentMint events: ${summarizeEvents(amSeq.flatMap((item) => item.events))}`,
      }),
    );
  }

  for (const scenario of [
    {
      name: "E2 Amount equals total",
      amount: 49.99,
      expectedViolation: false,
    },
    {
      name: "E3 Amount under total",
      amount: 10,
      expectedViolation: false,
    },
  ]) {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const fwSeq = [
      await framework.call("lookup_order", { order_id: "ORD-1" }),
      await framework.call("issue_refund", {
        order_id: "ORD-1",
        amount: scenario.amount,
        reason: "broken",
      }),
    ];
    const amSeq = [
      await agentmint.call("lookup_order", { order_id: "ORD-1" }),
      await agentmint.call("issue_refund", {
        order_id: "ORD-1",
        amount: scenario.amount,
        reason: "broken",
      }),
    ];
    results.push(
      buildResult({
        name: scenario.name,
        category: "enforcement",
        expectedViolation: scenario.expectedViolation,
        frameworkResult: summarizeSequence(fwSeq),
        agentmintResult: summarizeSequence(amSeq),
        frameworkCaught: fwSeq.some((item) => item.caught),
        agentmintCaught: amSeq.some((item) => item.caught),
        notes: `AgentMint events: ${summarizeEvents(amSeq.flatMap((item) => item.events))}`,
      }),
    );
  }

  {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const fwSeq = [
      await framework.call("lookup_order", { order_id: "ORD-1" }),
      await framework.call("issue_refund", {
        order_id: "ORD-999",
        amount: 30,
        reason: "broken",
      }),
    ];
    const amSeq = [
      await agentmint.call("lookup_order", { order_id: "ORD-1" }),
      await agentmint.call("issue_refund", {
        order_id: "ORD-999",
        amount: 30,
        reason: "broken",
      }),
    ];
    results.push(
      buildResult({
        name: "E4 Cross-ref mismatch",
        category: "enforcement",
        expectedViolation: true,
        frameworkResult: summarizeSequence(fwSeq),
        agentmintResult: summarizeSequence(amSeq),
        frameworkCaught: fwSeq.some((item) => item.caught),
        agentmintCaught: amSeq.some((item) => item.caught),
        notes: `AgentMint events: ${summarizeEvents(amSeq.flatMap((item) => item.events))}`,
      }),
    );
  }

  {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const fwSeq = [
      await framework.call("lookup_order", { order_id: "ORD-1" }),
      await framework.call("issue_refund", {
        order_id: "ORD-1",
        amount: 30,
        reason: "broken",
      }),
    ];
    const amSeq = [
      await agentmint.call("lookup_order", { order_id: "ORD-1" }),
      await agentmint.call("issue_refund", {
        order_id: "ORD-1",
        amount: 30,
        reason: "broken",
      }),
    ];
    results.push(
      buildResult({
        name: "E5 Cross-ref match",
        category: "enforcement",
        expectedViolation: false,
        frameworkResult: summarizeSequence(fwSeq),
        agentmintResult: summarizeSequence(amSeq),
        frameworkCaught: fwSeq.some((item) => item.caught),
        agentmintCaught: amSeq.some((item) => item.caught),
        notes: `AgentMint events: ${summarizeEvents(amSeq.flatMap((item) => item.events))}`,
      }),
    );
  }

  for (const scenario of [
    {
      name: "E6 Blocked tool",
      tool: "delete_order" as const,
      args: { order_id: "ORD-1" },
      expectedViolation: true,
    },
    {
      name: "E7 Unblocked tool",
      tool: "transfer_to_supervisor" as const,
      args: { reason: "escalation" },
      expectedViolation: false,
    },
  ]) {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const [fw, am] = await Promise.all([
      framework.call(scenario.tool, scenario.args),
      agentmint.call(scenario.tool, scenario.args),
    ]);
    results.push(
      buildResult({
        name: scenario.name,
        category: "enforcement",
        expectedViolation: scenario.expectedViolation,
        frameworkResult: summarizeOutcome(fw),
        agentmintResult: summarizeOutcome(am),
        frameworkCaught: fw.caught,
        agentmintCaught: am.caught,
        notes: `AgentMint events: ${summarizeEvents(am.events)}`,
      }),
    );
  }

  {
    const auditSequence = [
      { tool: "lookup_order" as const, args: { order_id: "ORD-1" } },
      { tool: "lookup_customer" as const, args: { customer_id: "CUST-1" } },
      {
        tool: "issue_refund" as const,
        args: { order_id: "ORD-1", amount: 30, reason: "broken" },
      },
      {
        tool: "send_notification" as const,
        args: { customer_id: "CUST-1", message: "refund processed" },
      },
    ];
    const frameworkAudit = await runFrameworkAudit(auditSequence);
    const agentmint = new ScenarioEnv("agentmint");
    for (const step of auditSequence) {
      await agentmint.call(step.tool, step.args);
    }
    const state = agentmint.getState()!;
    const frameworkCaught = false;
    const agentmintCaught = state.events.some(
      (event) => event.result === "warned" || event.result === "blocked",
    );
    results.push(
      buildResult({
        name: "A1 Full clean flow audit",
        category: "audit",
        expectedViolation: false,
        frameworkResult: `history=${frameworkAudit.historyCount}, argsInHistory=${frameworkAudit.argsInHistory}, resultsInHistory=${frameworkAudit.resultsInHistory}, sampleToolsEvent=${summarizeValue(frameworkAudit.sampleToolEvent)}`,
        agentmintResult: `events=${state.events.length}, fields=timestamp/tool/params/result/reason/details/durationMs`,
        frameworkCaught,
        agentmintCaught,
        notes: `Framework checkpoints are structured but not policy-aware; AgentMint events: ${summarizeEvents(state.events)}`,
      }),
    );
  }

  {
    const auditSequence = [
      {
        tool: "issue_refund" as const,
        args: { order_id: "ORD-1", amount: 30, reason: "broken" },
      },
      { tool: "lookup_order" as const, args: { order_id: "ORD-1" } },
      {
        tool: "issue_refund" as const,
        args: { order_id: "ORD-1", amount: 200, reason: "broken" },
      },
      {
        tool: "issue_refund" as const,
        args: { order_id: "ORD-1", amount: 30, reason: "broken" },
      },
    ];
    const frameworkAudit = await runFrameworkAudit(auditSequence);
    const agentmint = new ScenarioEnv("agentmint");
    for (const step of auditSequence) {
      await agentmint.call(step.tool, step.args);
    }
    const state = agentmint.getState()!;
    const frameworkCaught = false;
    const agentmintCaught = state.events.some(
      (event) => event.result === "warned" || event.result === "blocked",
    );
    results.push(
      buildResult({
        name: "A2 Mixed flow audit",
        category: "audit",
        expectedViolation: true,
        frameworkResult: `history=${frameworkAudit.historyCount}, argsInHistory=${frameworkAudit.argsInHistory}, resultsInHistory=${frameworkAudit.resultsInHistory}, policyFieldPresent=${frameworkAudit.policyFieldPresent}`,
        agentmintResult: `events=${state.events.length}, blocked=${state.events.some((event) => event.result === "blocked")}, warned=${state.events.some((event) => event.result === "warned")}, allowed=${state.events.some((event) => event.result === "allowed")}`,
        frameworkCaught,
        agentmintCaught,
        notes: `AgentMint event trail: ${summarizeEvents(state.events)}`,
      }),
    );
  }

  {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const fwSeq: ToolCallOutcome[] = [];
    const amSeq: ToolCallOutcome[] = [];
    for (let i = 0; i < 5; i += 1) {
      fwSeq.push(
        await framework.call("update_order_status", {
          order_id: "ORD-1",
          status: "shipped",
        }),
      );
      amSeq.push(
        await agentmint.call("update_order_status", {
          order_id: "ORD-1",
          status: "shipped",
        }),
      );
    }
    const firstBlocked = amSeq.findIndex((item) => item.blocked);
    results.push(
      buildResult({
        name: "B1 Identical args loop",
        category: "breaker",
        expectedViolation: true,
        frameworkResult: summarizeSequence(fwSeq),
        agentmintResult: summarizeSequence(amSeq),
        frameworkCaught: fwSeq.some((item) => item.caught),
        agentmintCaught: amSeq.some((item) => item.caught),
        notes: `AgentMint first blocked call index=${firstBlocked >= 0 ? firstBlocked + 1 : "none"}`,
      }),
    );
  }

  {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const fwSeq: ToolCallOutcome[] = [];
    const amSeq: ToolCallOutcome[] = [];
    for (const orderId of ["ORD-1", "ORD-2", "ORD-3"]) {
      fwSeq.push(await framework.call("lookup_order", { order_id: orderId }));
      amSeq.push(await agentmint.call("lookup_order", { order_id: orderId }));
    }
    results.push(
      buildResult({
        name: "B2 Different args not a loop",
        category: "breaker",
        expectedViolation: false,
        frameworkResult: summarizeSequence(fwSeq),
        agentmintResult: summarizeSequence(amSeq),
        frameworkCaught: fwSeq.some((item) => item.caught),
        agentmintCaught: amSeq.some((item) => item.caught),
        notes: `AgentMint events: ${summarizeEvents(amSeq.flatMap((item) => item.events))}`,
      }),
    );
  }

  {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const fwSeq: ToolCallOutcome[] = [];
    const amSeq: ToolCallOutcome[] = [];
    for (let i = 0; i < 12; i += 1) {
      const args = { order_id: `ORD-${i + 1}` };
      fwSeq.push(await framework.call("lookup_order", args));
      amSeq.push(await agentmint.call("lookup_order", args));
    }
    const firstBlocked = amSeq.findIndex((item) => item.blocked);
    results.push(
      buildResult({
        name: "B3 Velocity burst",
        category: "breaker",
        expectedViolation: true,
        frameworkResult: summarizeSequence(fwSeq),
        agentmintResult: summarizeSequence(amSeq),
        frameworkCaught: fwSeq.some((item) => item.caught),
        agentmintCaught: amSeq.some((item) => item.caught),
        notes: `AgentMint first blocked call index=${firstBlocked >= 0 ? firstBlocked + 1 : "none"}`,
      }),
    );
  }

  {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const fwSeq: ToolCallOutcome[] = [];
    const amSeq: ToolCallOutcome[] = [];
    for (let i = 0; i < 3; i += 1) {
      const args = { order_id: `ORD-${i + 1}` };
      fwSeq.push(await framework.call("lookup_order", args));
      amSeq.push(await agentmint.call("lookup_order", args));
      if (i < 2) {
        await sleep(5000);
      }
    }
    results.push(
      buildResult({
        name: "B4 Slow calls under velocity",
        category: "breaker",
        expectedViolation: false,
        frameworkResult: summarizeSequence(fwSeq),
        agentmintResult: summarizeSequence(amSeq),
        frameworkCaught: fwSeq.some((item) => item.caught),
        agentmintCaught: amSeq.some((item) => item.caught),
        notes: `AgentMint events: ${summarizeEvents(amSeq.flatMap((item) => item.events))}`,
      }),
    );
  }

  {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const fwSeq = [
      await framework.call("lookup_order", { order_id: "ORD-1" }),
      await framework.call("lookup_customer", { customer_id: "CUST-1" }),
      await framework.call("issue_refund", {
        order_id: "ORD-1",
        amount: 30,
        reason: "broken",
      }),
      await framework.call("send_notification", {
        customer_id: "CUST-1",
        message: "refund processed",
      }),
    ];
    const amSeq = [
      await agentmint.call("lookup_order", { order_id: "ORD-1" }),
      await agentmint.call("lookup_customer", { customer_id: "CUST-1" }),
      await agentmint.call("issue_refund", {
        order_id: "ORD-1",
        amount: 30,
        reason: "broken",
      }),
      await agentmint.call("send_notification", {
        customer_id: "CUST-1",
        message: "refund processed",
      }),
    ];
    results.push(
      buildResult({
        name: "C1 Perfect customer service flow",
        category: "clean",
        expectedViolation: false,
        frameworkResult: summarizeSequence(fwSeq),
        agentmintResult: summarizeSequence(amSeq),
        frameworkCaught: fwSeq.some((item) => item.caught),
        agentmintCaught: amSeq.some((item) => item.caught),
        notes: `AgentMint events: ${summarizeEvents(amSeq.flatMap((item) => item.events))}`,
      }),
    );
  }

  {
    const frameworkRun1 = new ScenarioEnv("framework");
    const frameworkRun2 = new ScenarioEnv("framework");
    const agentRun1 = new ScenarioEnv("agentmint");
    const agentRun2 = new ScenarioEnv("agentmint");
    const fwSeq = [
      await frameworkRun1.call("lookup_order", { order_id: "ORD-1" }),
      await frameworkRun1.call("issue_refund", {
        order_id: "ORD-1",
        amount: 30,
        reason: "broken",
      }),
      await frameworkRun2.call("lookup_order", { order_id: "ORD-2" }),
      await frameworkRun2.call("issue_refund", {
        order_id: "ORD-2",
        amount: 20,
        reason: "damaged",
      }),
    ];
    const amSeq = [
      await agentRun1.call("lookup_order", { order_id: "ORD-1" }),
      await agentRun1.call("issue_refund", {
        order_id: "ORD-1",
        amount: 30,
        reason: "broken",
      }),
      await agentRun2.call("lookup_order", { order_id: "ORD-2" }),
      await agentRun2.call("issue_refund", {
        order_id: "ORD-2",
        amount: 20,
        reason: "damaged",
      }),
    ];
    results.push(
      buildResult({
        name: "C2 Multiple independent workflows",
        category: "clean",
        expectedViolation: false,
        frameworkResult: summarizeSequence(fwSeq),
        agentmintResult: summarizeSequence(amSeq),
        frameworkCaught: fwSeq.some((item) => item.caught),
        agentmintCaught: amSeq.some((item) => item.caught),
        notes: `AgentMint fresh-run isolation confirmed via zero warnings/blocks`,
      }),
    );
  }

  {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const [fw, am] = await Promise.all([
      framework.call("transfer_to_supervisor", { reason: "escalation" }),
      agentmint.call("transfer_to_supervisor", { reason: "escalation" }),
    ]);
    results.push(
      buildResult({
        name: "X1 Tool not in spec",
        category: "edge",
        expectedViolation: false,
        frameworkResult: summarizeOutcome(fw),
        agentmintResult: summarizeOutcome(am),
        frameworkCaught: fw.caught,
        agentmintCaught: am.caught,
        notes: `AgentMint events: ${summarizeEvents(am.events)}`,
      }),
    );
  }

  {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const [fw, am] = await Promise.all([
      framework.call("lookup_order", {}),
      agentmint.call("lookup_order", {}),
    ]);
    results.push(
      buildResult({
        name: "X2 Empty args",
        category: "edge",
        expectedViolation: true,
        frameworkResult: summarizeOutcome(fw),
        agentmintResult: summarizeOutcome(am),
        frameworkCaught: fw.caught,
        agentmintCaught: am.caught,
        notes: `Both sides are caught by LangGraph tool-schema validation before the raw function runs.`,
      }),
    );
  }

  {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const [fw, am] = await Promise.all([
      framework.call("issue_refund", {
        order_id: undefined,
        amount: null,
        reason: "",
      }),
      agentmint.call("issue_refund", {
        order_id: undefined,
        amount: null,
        reason: "",
      }),
    ]);
    results.push(
      buildResult({
        name: "X3 Null and undefined args",
        category: "edge",
        expectedViolation: true,
        frameworkResult: summarizeOutcome(fw),
        agentmintResult: summarizeOutcome(am),
        frameworkCaught: fw.caught,
        agentmintCaught: am.caught,
        notes: `Both sides are caught by LangGraph tool-schema validation before the raw function runs.`,
      }),
    );
  }

  {
    const framework = new ScenarioEnv("framework");
    const agentmint = new ScenarioEnv("agentmint");
    const fwSeq = [
      await framework.call("lookup_order", { order_id: "ORD-1" }),
      await framework.call("issue_refund", {
        order_id: "ORD-1",
        amount: 30,
        reason: "broken",
      }),
      await framework.call("lookup_order", { order_id: "ORD-1" }),
      await framework.call("issue_refund", {
        order_id: "ORD-1",
        amount: 30,
        reason: "broken",
      }),
    ];
    const amSeq = [
      await agentmint.call("lookup_order", { order_id: "ORD-1" }),
      await agentmint.call("issue_refund", {
        order_id: "ORD-1",
        amount: 30,
        reason: "broken",
      }),
      await agentmint.call("lookup_order", { order_id: "ORD-1" }),
      await agentmint.call("issue_refund", {
        order_id: "ORD-1",
        amount: 30,
        reason: "broken",
      }),
    ];
    results.push(
      buildResult({
        name: "X4 Rapid alternating calls",
        category: "edge",
        expectedViolation: false,
        frameworkResult: summarizeSequence(fwSeq),
        agentmintResult: summarizeSequence(amSeq),
        frameworkCaught: fwSeq.some((item) => item.caught),
        agentmintCaught: amSeq.some((item) => item.caught),
        notes: `No loop breaker fired because identical calls were not repeated 3 times consecutively per tool.`,
      }),
    );
  }

  const baselineRaw = createRawTools();
  const agentmintLatencyTools = harden(createRawTools(), {
    spec: latencySpec,
    silent: true,
  }) as RawTools & { __state(): RunState };

  const baselineSamples: number[] = [];
  const agentmintSamples: number[] = [];

  for (let i = 0; i < 100; i += 1) {
    const args = { order_id: `LAT-${i}` };

    const baselineStart = performance.now();
    await baselineRaw.lookup_order(args);
    baselineSamples.push(performance.now() - baselineStart);

    const agentmintStart = performance.now();
    await agentmintLatencyTools.lookup_order(args);
    agentmintSamples.push(performance.now() - agentmintStart);
  }

  const baselineStats = {
    average:
      baselineSamples.reduce((sum, value) => sum + value, 0) /
      baselineSamples.length,
    p50: percentile(baselineSamples, 0.5),
    p99: percentile(baselineSamples, 0.99),
  };
  const agentmintStats = {
    average:
      agentmintSamples.reduce((sum, value) => sum + value, 0) /
      agentmintSamples.length,
    p50: percentile(agentmintSamples, 0.5),
    p99: percentile(agentmintSamples, 0.99),
  };
  const overheadMs = agentmintStats.average - baselineStats.average;
  const overheadPct =
    baselineStats.average === 0
      ? 0
      : (overheadMs / baselineStats.average) * 100;

  results.push(
    buildResult({
      name: "L1 Baseline latency",
      category: "latency",
      expectedViolation: false,
      frameworkResult: `avg=${baselineStats.average.toFixed(4)}ms p50=${baselineStats.p50.toFixed(4)}ms p99=${baselineStats.p99.toFixed(4)}ms`,
      agentmintResult: "See L2/L3",
      frameworkCaught: false,
      agentmintCaught: false,
      notes: "Latency benchmarks call the function objects directly to isolate wrapper overhead.",
    }),
  );

  results.push(
    buildResult({
      name: "L2 AgentMint latency",
      category: "latency",
      expectedViolation: false,
      frameworkResult: "See L1",
      agentmintResult: `avg=${agentmintStats.average.toFixed(4)}ms p50=${agentmintStats.p50.toFixed(4)}ms p99=${agentmintStats.p99.toFixed(4)}ms`,
      frameworkCaught: false,
      agentmintCaught: false,
      notes: "Latency run uses a minimal `version: 1.0` spec so loop/velocity breakers do not distort the benchmark.",
    }),
  );

  results.push(
    buildResult({
      name: "L3 Latency overhead",
      category: "latency",
      expectedViolation: false,
      frameworkResult: `avg=${baselineStats.average.toFixed(4)}ms`,
      agentmintResult: `avg=${agentmintStats.average.toFixed(4)}ms`,
      frameworkCaught: false,
      agentmintCaught: false,
      notes: `Overhead=${overheadMs.toFixed(4)}ms (${overheadPct.toFixed(2)}%)`,
    }),
  );

  return {
    results,
    latency: {
      baseline: baselineStats,
      agentmint: agentmintStats,
      overheadMs,
      overheadPct,
    },
  };
}

function renderMarkdown(
  results: TestResult[],
  latency: {
    baseline: { average: number; p50: number; p99: number };
    agentmint: { average: number; p50: number; p99: number };
    overheadMs: number;
    overheadPct: number;
  },
) {
  const research = readFileSync(resolve("research.md"), "utf8").trim();
  const tableRows = results
    .map((result) => {
      const escape = (value: string | boolean) =>
        String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
      return `| ${escape(result.name)} | ${escape(result.category)} | ${escape(result.framework_caught)} | ${escape(result.agentmint_caught)} | ${escape(result.agentmint_false_positive)} | ${escape(result.notes)} |`;
    })
    .join("\n");

  const falsePositives = results.filter((item) => item.agentmint_false_positive).length;
  const expectedViolations = new Set([
    "P1 Refund without lookup",
    "P2 Notification without customer lookup",
    "P4 Partial ordering",
    "E1 Amount exceeds total",
    "E4 Cross-ref mismatch",
    "E6 Blocked tool",
    "A2 Mixed flow audit",
    "B1 Identical args loop",
    "B3 Velocity burst",
    "X2 Empty args",
    "X3 Null and undefined args",
  ]);
  const missedByAgentMint = results.filter(
    (item) => expectedViolations.has(item.name) && !item.agentmint_caught,
  ).length;

  return `# LangGraph Governance Analysis

## Framework Research

${research}

## Results

| Test | Category | Framework catches? | AgentMint catches? | False positive? | Notes |
|------|----------|-------------------|-------------------|-----------------|-------|
${tableRows}

## Summary

- Framework built-in governance features found: tool input schema validation for standard LangChain tools, graph ordering via edges, checkpoint/state history, and node-level interrupts.
- Gaps AgentMint fills: prerequisite enforcement, cross-tool refs/max-value checks, explicit deny/block rules, identical-call loop breaking, velocity breaking, and a first-class policy event log.
- AgentMint false positives: ${falsePositives}
- AgentMint failures to catch: ${missedByAgentMint}
- Latency overhead: ${latency.overheadMs.toFixed(4)}ms (${latency.overheadPct.toFixed(2)}%)

## Honest assessment

Use LangGraph when you need orchestration, persistence, and human-in-the-loop control. Add AgentMint when you need runtime governance at the tool boundary: prerequisites, deny rules, cross-tool consistency checks, breaker policies, and audit events with policy outcomes. They solve different layers of the problem, so the strongest setup for governed agents is both together, not one instead of the other.
`;
}

async function main() {
  const { results, latency } = await runAllScenarios();

  writeFileSync(resolve("results.md"), renderMarkdown(results, latency));

  console.table(
    results.map((result) => ({
      Test: result.name,
      Category: result.category,
      Framework: result.framework_caught,
      AgentMint: result.agentmint_caught,
      FalsePositive: result.agentmint_false_positive,
    })),
  );

  console.log("");
  console.log(
    `Latency: baseline avg=${latency.baseline.average.toFixed(4)}ms, AgentMint avg=${latency.agentmint.average.toFixed(4)}ms, overhead=${latency.overheadMs.toFixed(4)}ms (${latency.overheadPct.toFixed(2)}%)`,
  );
  console.log(`Wrote ${resolve("results.md")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
