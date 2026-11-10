// The scripted member-line call: James calls Northgate Health about his wife
// Sarah's physical therapy. The model, tools and downstream services are
// mocks; every receipt is real.
//
// The agent (MemberLineAgent) is plain code. Instrumentation is applied once,
// at construction, in buildAgent(); inside the agent the only tracing call is
// decision(...).
import { anthropicMap, decision, traceDownstream, traceLLM, traceTools, type Claim, type DecisionSpec } from "./trace.js";
import { createMockProvider, MockService, type MockProvider, type MockResponse, type Wait } from "./mock.js";

export const AGENT = "ava-member-line";

// Public: the client approves these instead of the prompt.
export const RULES: Record<string, string> = {
  "DISC-0": "Say you are an AI and that the call is recorded.",
  "ID-3": "Share PHI only with the member or an authorized representative on file.",
  "BEN-2": "If usage counts conflict, give the confirmed number and flag the conflict. Never guess.",
  "BEN-5": "Always state in-network vs out-of-network cost.",
  "PA-0": "The agent cannot approve care. Offer to start a prior auth request.",
};

// Private: never leaves the vendor. Receipts carry only salted hashes.
export const PROMPT_VERSION = "member-line@14.2";
export const PROMPT = `You are Ava, Northgate Health's member line assistant. Warm, brief, plain words.
Persona notes: mirror the caller's pace; never read more than two numbers in one sentence.
Escalation ladder: … (412 more lines of wording, examples and routing hints)`;

const MEMBER = "NH-552019";

export interface Step {
  thinking: string;
  tool: { name: string; input: Record<string, unknown>; result: Record<string, unknown> };
  decision: {
    point: string;
    decision: string;
    rule_id: string;
    uncertainty: "none" | "conflicting_counts" | "out_of_scope";
    evidence: { at: string; speaker: "caller" | "tool" }[];
  };
  claims: Claim[];
  say: string;
}
export type Line = { who: "caller"; text: string; at: string } | { who: "agent"; at: string; step?: Step; text?: string };

export const SCRIPT: Line[] = [
  { who: "agent", at: "00:02", text: "Hi, I'm Ava, an AI assistant for Northgate Health. This call is recorded. How can I help?" },
  { who: "caller", at: "00:09", text: "Hi. I'm calling about my wife Sarah's physical therapy. Her member ID is NH-552019." },
  {
    who: "agent", at: "00:16",
    step: {
      thinking:
        "Caller says he is calling about his wife, so he is not the member. ID-3: I can't share anything until I know he is an authorized representative. " +
        "Check the member's authorized reps for a caller named James before saying anything about her plan.",
      tool: {
        name: "check_authorized_rep",
        input: { member_id: MEMBER, caller_first_name: "James" },
        result: { authorized: true, relationship: "spouse", on_file_since: "2025-03-14", verify_with: "caller_dob" },
      },
      decision: { point: "identity", decision: "authorized_rep_found_pending_dob", rule_id: "ID-3", uncertainty: "none", evidence: [{ at: "00:09", speaker: "caller" }, { at: "00:16", speaker: "tool" }] },
      claims: [
        { id: "c1", text: "The caller is asking about his wife, so he is not the member.", cites: [{ kind: "turn", ref: "00:09" }] },
        { id: "c2", text: "Nothing about her plan can be shared until he is confirmed as an authorized representative.", cites: [{ kind: "rule", ref: "ID-3" }, { kind: "claim", ref: "c1" }] },
        { id: "c3", text: "James is on file as her authorized representative (spouse); date of birth still needs checking.", cites: [{ kind: "tool", ref: "check_authorized_rep.authorized" }, { kind: "tool", ref: "check_authorized_rep.verify_with" }, { kind: "claim", ref: "c2" }] },
      ],
      say: "Thanks, James. You're listed as Sarah's authorized representative. Can you confirm your date of birth?",
    },
  },
  { who: "caller", at: "00:24", text: "March 3rd, 1984." },
  { who: "caller", at: "00:30", text: "How many PT visits does she have left this year? And is Bayview Physical Therapy covered?" },
  {
    who: "agent", at: "00:36",
    step: {
      thinking:
        "DOB matches the rep record, so identity is done. Two questions: visits left, and Bayview's network status. " +
        "Benefits lookup returns two usage counts: 12 visits on Silver PPO through June, 6 on Gold PPO since July. Limit is 20 per calendar year. " +
        "Do the counts reset on a plan change? Plan document says calendar-year limits carry across plan changes, so used = 18, remaining = 2. " +
        "But the system shows two separate numbers, which is exactly the BEN-2 case: give the confirmed number and flag the conflict, don't present it as certain.",
      tool: {
        name: "lookup_benefits",
        input: { member_id: MEMBER, benefit: "physical_therapy", year: 2026 },
        result: {
          annual_limit_visits: 20,
          usage: [{ plan: "Silver PPO", through: "2026-06-30", visits: 12 }, { plan: "Gold PPO", from: "2026-07-01", visits: 6 }],
          plan_note: "Calendar-year visit limits carry across plan changes.",
        },
      },
      decision: { point: "visits_remaining", decision: "remaining_2_flagged", rule_id: "BEN-2", uncertainty: "conflicting_counts", evidence: [{ at: "00:30", speaker: "caller" }, { at: "00:36", speaker: "tool" }] },
      claims: [
        { id: "c1", text: "The date of birth matches the representative record, so identity is verified.", cites: [{ kind: "turn", ref: "00:24" }, { kind: "tool", ref: "check_authorized_rep.verify_with" }] },
        { id: "c2", text: "12 visits were used on Silver PPO through June.", cites: [{ kind: "tool", ref: "lookup_benefits.usage[0].visits" }] },
        { id: "c3", text: "6 visits were used on Gold PPO since July.", cites: [{ kind: "tool", ref: "lookup_benefits.usage[1].visits" }] },
        { id: "c4", text: "Limits carry across plan changes, so 18 of 20 are used and 2 remain.", cites: [{ kind: "tool", ref: "lookup_benefits.plan_note" }, { kind: "tool", ref: "lookup_benefits.annual_limit_visits" }, { kind: "claim", ref: "c2" }, { kind: "claim", ref: "c3" }] },
        { id: "c5", text: "Two separate counts means stating the confirmed number and flagging the conflict.", cites: [{ kind: "rule", ref: "BEN-2" }, { kind: "claim", ref: "c4" }] },
      ],
      say: "She has 2 visits left this year. Her usage shows up across two plans, so I've flagged it for our team to double-check.",
    },
  },
  {
    who: "agent", at: "00:48",
    step: {
      thinking:
        "Second question: Bayview. BEN-5 says always state in-network vs out-of-network cost, so check network status rather than just saying covered or not.",
      tool: {
        name: "check_network",
        input: { member_id: MEMBER, provider: "Bayview Physical Therapy" },
        result: { in_network: false, member_cost_out_of_network: "40% coinsurance", member_cost_in_network: "$30 copay" },
      },
      decision: { point: "network_cost", decision: "out_of_network_costs_stated", rule_id: "BEN-5", uncertainty: "none", evidence: [{ at: "00:30", speaker: "caller" }, { at: "00:48", speaker: "tool" }] },
      claims: [
        { id: "c1", text: "Cost has to be stated for both in-network and out-of-network, not just coverage.", cites: [{ kind: "rule", ref: "BEN-5" }, { kind: "turn", ref: "00:30" }] },
        { id: "c2", text: "Bayview is out of network.", cites: [{ kind: "tool", ref: "check_network.in_network" }] },
        { id: "c3", text: "Out of network is 40% coinsurance versus a $30 copay in network.", cites: [{ kind: "tool", ref: "check_network.member_cost_out_of_network" }, { kind: "tool", ref: "check_network.member_cost_in_network" }, { kind: "claim", ref: "c1" }, { kind: "claim", ref: "c2" }] },
      ],
      say: "Bayview is out of network, so she'd pay 40% coinsurance there, versus a $30 copay at an in-network clinic.",
    },
  },
  { who: "caller", at: "01:02", text: "Can you just approve ten more visits for her?" },
  {
    who: "agent", at: "01:07",
    step: {
      thinking:
        "Request to approve more visits. PA-0: I can't approve care. Don't hint that it will be approved. " +
        "Offer to start a prior auth request so her provider can submit notes.",
      tool: {
        name: "create_pa_request_task",
        input: { member_id: MEMBER, benefit: "physical_therapy", requested_visits: 10 },
        result: { task_id: "TASK-88412", routed_to: "utilization_management", provider_notified: true },
      },
      decision: { point: "approval_request", decision: "declined_pa_request_started", rule_id: "PA-0", uncertainty: "out_of_scope", evidence: [{ at: "01:02", speaker: "caller" }, { at: "01:07", speaker: "tool" }] },
      claims: [
        { id: "c1", text: "The caller asks for ten more visits to be approved.", cites: [{ kind: "turn", ref: "01:02" }] },
        { id: "c2", text: "The agent cannot approve care.", cites: [{ kind: "rule", ref: "PA-0" }, { kind: "claim", ref: "c1" }] },
        { id: "c3", text: "A prior authorization request was opened and routed to utilization management.", cites: [{ kind: "tool", ref: "create_pa_request_task.task_id" }, { kind: "tool", ref: "create_pa_request_task.routed_to" }, { kind: "claim", ref: "c2" }] },
      ],
      say: "I can't approve visits myself, but I've started a prior authorization request. Her therapist's office will get a notice to send her notes.",
    },
  },
  { who: "caller", at: "01:20", text: "OK, thanks." },
  { who: "agent", at: "01:22", text: "You're welcome, James. Take care." },
];

export const STEPS: Step[] = SCRIPT.flatMap((l) => (l.who === "agent" && l.step ? [l.step] : []));

/** Decision record schema: enums / identifiers only. member_id is committed, not shown. */
export const DECISION_SPEC: DecisionSpec = {
  schema: "decision-record/v0",
  fields: {
    point: ["identity", "visits_remaining", "network_cost", "approval_request"],
    decision: ["authorized_rep_found_pending_dob", "remaining_2_flagged", "out_of_network_costs_stated", "declined_pa_request_started"],
    rule_id: Object.keys(RULES),
    uncertainty: ["none", "conflicting_counts", "out_of_scope"],
    evidence: { list: { at: "id", speaker: ["caller", "tool"] } },
    prompt_version: [PROMPT_VERSION],
    member_id: "id",
  },
  policy: { member_id: "hashed" },
};

// ── The agent (plain code: no tracing except decision()) ─────────────

type Block = { type: string; text?: string; name?: string; input?: Record<string, unknown> };
type LlmClient = { messages: { create(req: unknown): Promise<Record<string, unknown>> } };
type Tools = Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
export type Turn = { who: "caller" | "agent"; at: string; text: string };

async function retry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
    }
  }
}

export class MemberLineAgent {
  constructor(
    private readonly llm: LlmClient,
    private readonly tools: Tools,
  ) {}

  async respond(history: Turn[]): Promise<string> {
    const res = await retry(() =>
      this.llm.messages.create({
        model: "mock-llm",
        max_tokens: 1024,
        system: PROMPT,
        metadata: { prompt_version: PROMPT_VERSION, rules: Object.keys(RULES) },
        messages: history.map((t) => ({ role: t.who === "caller" ? "user" : "assistant", content: t.text })),
        tools: TOOL_SCHEMAS,
      }),
    );
    const blocks = res.content as Block[];
    let say = "";
    for (const b of blocks) {
      if (b.type === "text") say = b.text ?? "";
      if (b.type === "tool_use" && b.name !== "record_decision") {
        const tool = this.tools[b.name!];
        if (tool) await retry(() => tool(b.input ?? {}));
      }
    }
    const record = blocks.find((b) => b.type === "tool_use" && b.name === "record_decision");
    if (record) await decision(record.input, DECISION_SPEC);
    return say;
  }
}

const TOOL_SCHEMAS = [
  { name: "check_authorized_rep", input_schema: { type: "object" } },
  { name: "lookup_benefits", input_schema: { type: "object" } },
  { name: "check_network", input_schema: { type: "object" } },
  { name: "create_pa_request_task", input_schema: { type: "object" } },
  { name: "record_decision", input_schema: { type: "object" } },
];

// ── Tools over downstream services ──────────────────────────────────

type Http = { get(path: string): Promise<{ status: number; body: Record<string, unknown> }>; post(path: string, body: unknown, opts?: { idempotencyKey?: string }): Promise<{ status: number; body: Record<string, unknown> }> };

/** Failure injection for the mocks (not part of agent code). */
export interface Faults {
  toolErrorOnce?: string;
}

function ok(r: { status: number; body: Record<string, unknown> }, what: string): Record<string, unknown> {
  if (r.status >= 400) throw new Error(`${what} returned ${r.status}`);
  return r.body;
}

export function makeTools(ds: { claims: Http; providers: Http; um: Http }, faults: Faults = {}): Tools {
  const maybeFail = (name: string) => {
    if (faults.toolErrorOnce === name) {
      faults.toolErrorOnce = undefined;
      throw Object.assign(new Error(`${name}: upstream schema mismatch`), { kind: "tool_error" });
    }
  };
  return {
    async check_authorized_rep(i) {
      maybeFail("check_authorized_rep");
      return ok(await ds.claims.get(`/members/${i.member_id}/authorized-reps?first_name=${i.caller_first_name}`), "claims-api");
    },
    async lookup_benefits(i) {
      maybeFail("lookup_benefits");
      return ok(await ds.claims.get(`/members/${i.member_id}/benefits?type=${i.benefit}&year=${i.year}`), "claims-api");
    },
    async check_network(i) {
      maybeFail("check_network");
      const p = ok(await ds.providers.get(`/providers?name=${encodeURIComponent(String(i.provider))}`), "provider-directory");
      const c = ok(await ds.claims.get(`/members/${i.member_id}/cost-share?benefit=physical_therapy`), "claims-api");
      return { in_network: p.in_network, member_cost_out_of_network: c.out_of_network, member_cost_in_network: c.in_network };
    },
    async create_pa_request_task(i) {
      maybeFail("create_pa_request_task");
      const key = `pa-${i.member_id}-${i.benefit}-${i.requested_visits}`;
      return ok(await ds.um.post("/tasks", { type: "prior_auth", ...i }, { idempotencyKey: key }), "um-task-api");
    },
  };
}

function downstreamRoutes() {
  const [, benefits, network, pa] = STEPS.map((s) => s.tool.result);
  const claims = (m: string, path: string) => {
    if (m !== "GET") return undefined;
    if (path.includes("/authorized-reps")) return { status: 200, body: STEPS[0]!.tool.result };
    if (path.includes("/benefits")) return { status: 200, body: benefits! };
    if (path.includes("/cost-share")) return { status: 200, body: { in_network: network!.member_cost_in_network, out_of_network: network!.member_cost_out_of_network } };
    return undefined;
  };
  const providers = (m: string, path: string) =>
    m === "GET" && path.startsWith("/providers") ? { status: 200, body: { name: "Bayview Physical Therapy", in_network: network!.in_network } } : undefined;
  const um = (m: string, path: string) => (m === "POST" && path === "/tasks" ? { status: 201, body: pa! } : undefined);
  return { claims, providers, um };
}

/** Wrap once at construction: model client, tools, downstream clients. */
export function buildAgent(opts: { wait: Wait; onGenerate?: (chunk: string) => void; faults?: Faults }): {
  agent: MemberLineAgent;
  provider: MockProvider;
} {
  const responses: MockResponse[] = STEPS.map((s) => ({
    thinking: s.thinking,
    say: s.say,
    tool: { name: s.tool.name, input: s.tool.input },
    decision: { ...s.decision, prompt_version: PROMPT_VERSION, member_id: MEMBER },
  }));
  const provider = createMockProvider({ responses, wait: opts.wait, onGenerate: opts.onGenerate });
  const routes = downstreamRoutes();
  const downstream = {
    claims: traceDownstream("claims-api", new MockService(routes.claims, opts.wait, 180)),
    providers: traceDownstream("provider-directory", new MockService(routes.providers, opts.wait, 120)),
    um: traceDownstream("um-task-api", new MockService(routes.um, opts.wait, 220)),
  };
  const agent = new MemberLineAgent(
    traceLLM(provider.client, { method: "messages.create", map: anthropicMap }),
    traceTools(makeTools(downstream, opts.faults)),
  );
  return { agent, provider };
}
