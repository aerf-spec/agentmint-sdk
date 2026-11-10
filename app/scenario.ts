// The scripted member-line call: James calls Northgate Health about his wife
// Sarah's physical therapy. Ten agent decisions, each with raw thinking, cited
// claims, a tool call and downstream service calls. The model, tools and
// services are mocks; every receipt is real.
//
// The agent (MemberLineAgent) is plain code. Instrumentation is applied once,
// at construction, in buildAgent(); inside the agent the only tracing call is
// decision(...).
import { anthropicMap, decision, traceDownstream, traceLLM, traceTools, type Claim, type DecisionSpec } from "./trace.js";
import { createMockProvider, MockService, type HttpResult, type MockProvider, type MockResponse, type Wait } from "./mock.js";

export const AGENT = "ava-member-line";

// Public: the client approves these instead of the prompt.
export const RULES: Record<string, string> = {
  "DISC-0": "Say you are an AI and that the call is recorded.",
  "ID-3": "Share PHI only with the member or an authorized representative on file.",
  "ID-4": "Verify an authorized representative's date of birth before sharing PHI.",
  "BEN-2": "If usage counts conflict, give the confirmed number and flag the conflict. Never guess.",
  "BEN-5": "Always state in-network vs out-of-network cost.",
  "NET-1": "When a provider is out of network, offer in-network alternatives.",
  "COST-1": "Cost estimates must say they are estimates and separate covered from non-covered amounts.",
  "PA-0": "The agent cannot approve care. Offer to start a prior auth request.",
  "APL-1": "When care may be denied, explain appeal rights and timelines.",
  "TCPA-1": "Text the caller only with explicit consent given on this call.",
  "DOC-1": "Log every call with disposition codes before ending it.",
};

// Private: never leaves the vendor. Receipts carry only salted hashes.
export const PROMPT_VERSION = "member-line@14.2";
export const PROMPT = `You are Ava, Northgate Health's member line assistant. Warm, brief, plain words.
Persona notes: mirror the caller's pace; never read more than two numbers in one sentence.
Escalation ladder: … (412 more lines of wording, examples and routing hints)`;

const MEMBER = "NH-552019";

export interface Downstream {
  service: "claims-api" | "provider-directory" | "um-task-api" | "notify-api" | "crm-api";
  method: "GET" | "POST";
  path: string;
  status: number;
  body: Record<string, unknown>;
}

export interface Step {
  thinking: string;
  tool: { name: string; input: Record<string, unknown>; result: Record<string, unknown> };
  downstream: Downstream[];
  decision: {
    point: string;
    decision: string;
    rule_id: string;
    uncertainty: "none" | "conflicting_counts" | "out_of_scope" | "estimate";
    evidence: { at: string; speaker: "caller" | "tool" }[];
  };
  claims: Claim[];
  say: string;
}
export type Line = { who: "caller"; text: string; at: string } | { who: "agent"; at: string; step?: Step; text?: string };

const c = (id: string, text: string, ...cites: Claim["cites"]): Claim => ({ id, text, cites });
const rule = (ref: string) => ({ kind: "rule" as const, ref });
const tool = (ref: string) => ({ kind: "tool" as const, ref });
const turn = (ref: string) => ({ kind: "turn" as const, ref });
const claim = (ref: string) => ({ kind: "claim" as const, ref });
const ev = (callerAt: string, toolAt: string) => [{ at: callerAt, speaker: "caller" as const }, { at: toolAt, speaker: "tool" as const }];

const BENEFITS = {
  annual_limit_visits: 20,
  usage: [{ plan: "Silver PPO", through: "2026-06-30", visits: 12 }, { plan: "Gold PPO", from: "2026-07-01", visits: 6 }],
  plan_note: "Calendar-year visit limits carry across plan changes.",
};
const ALTERNATIVES = {
  providers: [
    { name: "Riverside Rehab Partners", distance_tenths_mi: 12, in_network: true, copay_usd: 30, next_opening: "2026-11-13" },
    { name: "Lakeview PT", distance_tenths_mi: 34, in_network: true, copay_usd: 30, next_opening: "2026-11-11" },
  ],
};
const ESTIMATE = { covered_visits: 2, covered_copay_usd: 30, uncovered_visits: 8, est_allowed_usd_per_visit: 95, est_total_usd: 820, is_estimate: true };
const APPEALS = { window_days: 180, standard_decision_days: 30, expedited_decision_hours: 72 };

export const SCRIPT: Line[] = [
  { who: "agent", at: "00:02", text: "Hi, I'm Ava, an AI assistant for Northgate Health. This call is recorded. How can I help?" },
  { who: "caller", at: "00:09", text: "Hi. I'm calling about my wife Sarah's physical therapy. Her member ID is NH-552019." },
  {
    who: "agent", at: "00:16",
    step: {
      thinking:
        "Caller says he is calling about his wife, so he is not the member. ID-3: I can't share anything until I know he is an authorized representative. " +
        "Check the member's authorized reps for a caller named James before saying anything about her plan.",
      tool: { name: "check_authorized_rep", input: { member_id: MEMBER, caller_first_name: "James" }, result: { authorized: true, relationship: "spouse", on_file_since: "2025-03-14", verify_with: "caller_dob" } },
      downstream: [{ service: "claims-api", method: "GET", path: `/members/${MEMBER}/authorized-reps?first_name=James`, status: 200, body: { reps: [{ first_name: "James", relationship: "spouse", on_file_since: "2025-03-14" }], verify_with: "caller_dob" } }],
      decision: { point: "identity", decision: "authorized_rep_found_pending_dob", rule_id: "ID-3", uncertainty: "none", evidence: ev("00:09", "00:16") },
      claims: [
        c("c1", "The caller is asking about his wife, so he is not the member.", turn("00:09")),
        c("c2", "Nothing about her plan can be shared until he is confirmed as an authorized representative.", rule("ID-3"), claim("c1")),
        c("c3", "James is on file as her authorized representative (spouse); date of birth still needs checking.", tool("check_authorized_rep.authorized"), tool("check_authorized_rep.verify_with"), claim("c2")),
      ],
      say: "Thanks, James. You're listed as Sarah's authorized representative. Can you confirm your date of birth?",
    },
  },
  { who: "caller", at: "00:24", text: "March 3rd, 1984." },
  {
    who: "agent", at: "00:28",
    step: {
      thinking:
        "He gave a date of birth. ID-4 says verify it against the rep record before any PHI. Send it to the verification endpoint rather than comparing it myself; " +
        "only a match unlocks benefits details.",
      tool: { name: "verify_rep_dob", input: { member_id: MEMBER, rep_first_name: "James", dob: "1984-03-03" }, result: { match: true, method: "rep_record" } },
      downstream: [{ service: "claims-api", method: "POST", path: `/members/${MEMBER}/authorized-reps/verify`, status: 200, body: { match: true, method: "rep_record" } }],
      decision: { point: "dob_verification", decision: "rep_verified", rule_id: "ID-4", uncertainty: "none", evidence: ev("00:24", "00:28") },
      claims: [
        c("c1", "The caller supplied a date of birth for verification.", turn("00:24")),
        c("c2", "The date of birth matches the representative record.", tool("verify_rep_dob.match"), claim("c1")),
        c("c3", "Identity is verified, so benefits details may now be shared with him.", rule("ID-4"), rule("ID-3"), claim("c2")),
      ],
      say: "Thank you, that matches. What can I help you with for Sarah's physical therapy?",
    },
  },
  { who: "caller", at: "00:34", text: "How many PT visits does she have left this year? And is Bayview Physical Therapy covered?" },
  {
    who: "agent", at: "00:40",
    step: {
      thinking:
        "Two questions: visits left, and Bayview's network status. " +
        "Benefits lookup returns two usage counts: 12 visits on Silver PPO through June, 6 on Gold PPO since July. Limit is 20 per calendar year. " +
        "Do the counts reset on a plan change? Plan document says calendar-year limits carry across plan changes, so used = 18, remaining = 2. " +
        "But the system shows two separate numbers, which is exactly the BEN-2 case: give the confirmed number and flag the conflict, don't present it as certain.",
      tool: { name: "lookup_benefits", input: { member_id: MEMBER, benefit: "physical_therapy", year: 2026 }, result: BENEFITS },
      downstream: [{ service: "claims-api", method: "GET", path: `/members/${MEMBER}/benefits?type=physical_therapy&year=2026`, status: 200, body: BENEFITS }],
      decision: { point: "visits_remaining", decision: "remaining_2_flagged", rule_id: "BEN-2", uncertainty: "conflicting_counts", evidence: ev("00:34", "00:40") },
      claims: [
        c("c1", "12 visits were used on Silver PPO through June.", tool("lookup_benefits.usage[0].visits")),
        c("c2", "6 visits were used on Gold PPO since July.", tool("lookup_benefits.usage[1].visits")),
        c("c3", "Limits carry across plan changes, so 18 of 20 are used and 2 remain.", tool("lookup_benefits.plan_note"), tool("lookup_benefits.annual_limit_visits"), claim("c1"), claim("c2")),
        c("c4", "Two separate counts means stating the confirmed number and flagging the conflict.", rule("BEN-2"), claim("c3")),
      ],
      say: "She has 2 visits left this year. Her usage shows up across two plans, so I've flagged it for our team to double-check.",
    },
  },
  {
    who: "agent", at: "00:52",
    step: {
      thinking:
        "Second question: Bayview. BEN-5 says always state in-network vs out-of-network cost, so check network status and both cost shares rather than just saying covered or not.",
      tool: { name: "check_network", input: { member_id: MEMBER, provider: "Bayview Physical Therapy" }, result: { in_network: false, member_cost_out_of_network: "40% coinsurance", member_cost_in_network: "$30 copay" } },
      downstream: [
        { service: "provider-directory", method: "GET", path: "/providers?name=Bayview%20Physical%20Therapy", status: 200, body: { name: "Bayview Physical Therapy", in_network: false } },
        { service: "claims-api", method: "GET", path: `/members/${MEMBER}/cost-share?benefit=physical_therapy`, status: 200, body: { in_network: "$30 copay", out_of_network: "40% coinsurance" } },
      ],
      decision: { point: "network_status", decision: "out_of_network_costs_stated", rule_id: "BEN-5", uncertainty: "none", evidence: ev("00:34", "00:52") },
      claims: [
        c("c1", "Cost has to be stated for both in-network and out-of-network, not just coverage.", rule("BEN-5"), turn("00:34")),
        c("c2", "Bayview is out of network.", tool("check_network.in_network")),
        c("c3", "Out of network is 40% coinsurance versus a $30 copay in network.", tool("check_network.member_cost_out_of_network"), tool("check_network.member_cost_in_network"), claim("c1"), claim("c2")),
      ],
      say: "Bayview is out of network, so she'd pay 40% coinsurance there, versus a $30 copay at an in-network clinic.",
    },
  },
  { who: "caller", at: "01:04", text: "Oh. Is there anything in network near us? We're in Riverside." },
  {
    who: "agent", at: "01:10",
    step: {
      thinking:
        "NET-1: Bayview is out of network, so offer in-network alternatives. Search the directory for physical therapy near Riverside on her Gold PPO network. " +
        "Give at most two options, with distance, so it stays easy to follow on the phone.",
      tool: { name: "find_in_network_providers", input: { member_id: MEMBER, specialty: "physical_therapy", near: "Riverside", limit: 2 }, result: ALTERNATIVES },
      downstream: [{ service: "provider-directory", method: "GET", path: "/providers?specialty=physical_therapy&near=Riverside&network=gold-ppo&limit=2", status: 200, body: ALTERNATIVES }],
      decision: { point: "in_network_alternatives", decision: "two_alternatives_offered", rule_id: "NET-1", uncertainty: "none", evidence: ev("01:04", "01:10") },
      claims: [
        c("c1", "The caller wants an in-network option near Riverside.", turn("01:04")),
        c("c2", "Out-of-network status triggers offering alternatives.", rule("NET-1"), claim("c1")),
        c("c3", "Riverside Rehab Partners is in network, 1.2 miles away.", tool("find_in_network_providers.providers[0].in_network"), tool("find_in_network_providers.providers[0].distance_tenths_mi")),
        c("c4", "Lakeview PT is in network, 3.4 miles away.", tool("find_in_network_providers.providers[1].in_network"), tool("find_in_network_providers.providers[1].distance_tenths_mi")),
      ],
      say: "Two in-network clinics are close to Riverside: Riverside Rehab Partners, about a mile away, and Lakeview PT, about three miles. Both are a $30 copay.",
    },
  },
  { who: "caller", at: "01:22", text: "She'll probably need about ten more visits. What would that cost?" },
  {
    who: "agent", at: "01:28",
    step: {
      thinking:
        "Ten visits, but only 2 remain under the limit. COST-1: separate covered from non-covered and say it's an estimate. Ask claims for an estimate at an in-network clinic: " +
        "2 covered at the $30 copay, 8 beyond the limit not covered unless prior auth is approved, estimated allowed amount around $95 each.",
      tool: { name: "estimate_cost", input: { member_id: MEMBER, service: "pt_visit", visits: 10, network: "in" }, result: ESTIMATE },
      downstream: [{ service: "claims-api", method: "GET", path: `/members/${MEMBER}/cost-estimate?service=pt_visit&visits=10&network=in`, status: 200, body: ESTIMATE }],
      decision: { point: "cost_estimate", decision: "estimate_split_covered_uncovered", rule_id: "COST-1", uncertainty: "estimate", evidence: ev("01:22", "01:28") },
      claims: [
        c("c1", "Two of the ten visits fall within the remaining limit at a $30 copay.", tool("estimate_cost.covered_visits"), tool("estimate_cost.covered_copay_usd")),
        c("c2", "Eight visits are beyond the limit and not covered without prior authorization.", tool("estimate_cost.uncovered_visits")),
        c("c3", "The uncovered visits are estimated at $95 each, $760 in total, so $820 overall.", tool("estimate_cost.est_allowed_usd_per_visit"), tool("estimate_cost.est_total_usd"), claim("c1"), claim("c2")),
        c("c4", "The figure must be presented as an estimate with covered and uncovered parts separated.", rule("COST-1"), claim("c3")),
      ],
      say: "At an in-network clinic, her 2 remaining visits are $30 each. The other 8 aren't covered unless a prior authorization is approved; those are estimated at about $95 each. That's an estimate, not a guarantee.",
    },
  },
  { who: "caller", at: "01:44", text: "Can you just approve ten more visits for her?" },
  {
    who: "agent", at: "01:49",
    step: {
      thinking:
        "Request to approve more visits. PA-0: I can't approve care. Don't hint that it will be approved. " +
        "Offer to start a prior auth request so her provider can submit notes.",
      tool: { name: "create_pa_request_task", input: { member_id: MEMBER, benefit: "physical_therapy", requested_visits: 10 }, result: { task_id: "TASK-88412", routed_to: "utilization_management", provider_notified: true } },
      downstream: [{ service: "um-task-api", method: "POST", path: "/tasks", status: 201, body: { task_id: "TASK-88412", routed_to: "utilization_management", provider_notified: true } }],
      decision: { point: "approval_request", decision: "declined_pa_request_started", rule_id: "PA-0", uncertainty: "out_of_scope", evidence: ev("01:44", "01:49") },
      claims: [
        c("c1", "The caller asks for ten more visits to be approved.", turn("01:44")),
        c("c2", "The agent cannot approve care.", rule("PA-0"), claim("c1")),
        c("c3", "A prior authorization request was opened and routed to utilization management.", tool("create_pa_request_task.task_id"), tool("create_pa_request_task.routed_to"), claim("c2")),
      ],
      say: "I can't approve visits myself, but I've started a prior authorization request. Her therapist's office will get a notice to send her notes.",
    },
  },
  { who: "caller", at: "02:02", text: "And if they say no?" },
  {
    who: "agent", at: "02:06",
    step: {
      thinking:
        "He's asking about a denial. APL-1: explain appeal rights and timelines. Pull the plan's appeal policy instead of quoting from memory: " +
        "filing window and decision times for standard and expedited appeals.",
      tool: { name: "get_appeal_policy", input: { member_id: MEMBER, plan: "gold-ppo" }, result: APPEALS },
      downstream: [{ service: "um-task-api", method: "GET", path: "/policies/appeals?plan=gold-ppo", status: 200, body: APPEALS }],
      decision: { point: "appeal_rights", decision: "appeal_rights_and_timelines_given", rule_id: "APL-1", uncertainty: "none", evidence: ev("02:02", "02:06") },
      claims: [
        c("c1", "The caller asks what happens if the request is denied.", turn("02:02")),
        c("c2", "Appeals can be filed within 180 days of a denial.", tool("get_appeal_policy.window_days")),
        c("c3", "Standard appeals are decided within 30 days and expedited ones within 72 hours.", tool("get_appeal_policy.standard_decision_days"), tool("get_appeal_policy.expedited_decision_hours")),
        c("c4", "Possible denial triggers explaining appeal rights and timelines.", rule("APL-1"), claim("c1"), claim("c2"), claim("c3")),
      ],
      say: "If it's denied, you can appeal within 180 days. Standard appeals are decided within 30 days, and urgent ones within 72 hours.",
    },
  },
  { who: "caller", at: "02:20", text: "Can you text me a summary of all this?" },
  {
    who: "agent", at: "02:24",
    step: {
      thinking:
        "He asked for a text. TCPA-1: only with explicit consent on this call. His request is explicit consent for a one-time summary. " +
        "Record the consent with the call reference, then send the summary to the mobile number on file.",
      tool: { name: "send_sms_summary", input: { member_id: MEMBER, recipient: "rep:james", consent: "explicit_on_call", template: "pt_benefits_summary" }, result: { consent_id: "CNS-30117", message_id: "SMS-771902", to_last4: "4471", status: "queued" } },
      downstream: [
        { service: "crm-api", method: "POST", path: `/members/${MEMBER}/consents`, status: 201, body: { consent_id: "CNS-30117", channel: "sms", scope: "one_time_summary" } },
        { service: "notify-api", method: "POST", path: "/messages", status: 202, body: { message_id: "SMS-771902", to_last4: "4471", status: "queued" } },
      ],
      decision: { point: "consent_to_text", decision: "consent_recorded_summary_sent", rule_id: "TCPA-1", uncertainty: "none", evidence: ev("02:20", "02:24") },
      claims: [
        c("c1", "The caller explicitly asked for a text summary on this call.", turn("02:20")),
        c("c2", "Texting requires explicit consent given on this call, which his request provides.", rule("TCPA-1"), claim("c1")),
        c("c3", "Consent was recorded and the summary was queued to the number ending 4471.", tool("send_sms_summary.consent_id"), tool("send_sms_summary.to_last4"), claim("c2")),
      ],
      say: "Done. I've texted a summary to the number ending in 4471.",
    },
  },
  { who: "caller", at: "02:36", text: "OK, thanks. That's everything." },
  {
    who: "agent", at: "02:39",
    step: {
      thinking:
        "Caller is done. DOC-1: log the call with disposition codes before ending: benefits inquiry answered, PA request opened, SMS summary sent. Then close warmly.",
      tool: { name: "log_interaction", input: { member_id: MEMBER, dispositions: ["benefits_inquiry", "pa_request_opened", "sms_summary_sent"], pa_task_id: "TASK-88412" }, result: { interaction_id: "INT-5520194", status: "logged" } },
      downstream: [{ service: "crm-api", method: "POST", path: "/interactions", status: 201, body: { interaction_id: "INT-5520194", status: "logged" } }],
      decision: { point: "close", decision: "call_logged_and_closed", rule_id: "DOC-1", uncertainty: "none", evidence: ev("02:36", "02:39") },
      claims: [
        c("c1", "The caller has no further questions.", turn("02:36")),
        c("c2", "The call was logged with its disposition codes before closing.", tool("log_interaction.interaction_id"), rule("DOC-1"), claim("c1")),
      ],
      say: "You're welcome, James. Take care.",
    },
  },
];

export const STEPS: Step[] = SCRIPT.flatMap((l) => (l.who === "agent" && l.step ? [l.step] : []));

/** Which step each injectable failure hits. */
export const FAULT_STEPS = { llm_timeout: 2, tool_error: 3, signer_crash: 6 } as const;

/** Decision record schema: enums / identifiers only. member_id is committed, not shown. */
export const DECISION_SPEC: DecisionSpec = {
  schema: "decision-record/v0",
  fields: {
    point: STEPS.map((s) => s.decision.point),
    decision: STEPS.map((s) => s.decision.decision),
    rule_id: Object.keys(RULES),
    uncertainty: ["none", "conflicting_counts", "out_of_scope", "estimate"],
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

export const TOOL_NAMES = [...new Set(STEPS.map((s) => s.tool.name))];

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
        tools: [...TOOL_NAMES, "record_decision"].map((name) => ({ name, input_schema: { type: "object" } })),
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

// ── Tools over downstream services ──────────────────────────────────

type Http = {
  get(path: string): Promise<HttpResult>;
  post(path: string, body: unknown, opts?: { idempotencyKey?: string }): Promise<HttpResult>;
};
type Clients = Record<Downstream["service"], Http>;

/** Failure injection for the mocks (not part of agent code). */
export interface Faults {
  toolErrorOnce?: string;
}

/**
 * Each tool makes its step's downstream calls through the (wrapped) service
 * clients and returns the tool result. Tool code knows nothing about tracing.
 */
export function makeTools(clients: Clients, faults: Faults = {}): Tools {
  const tools: Tools = {};
  for (const s of STEPS) {
    tools[s.tool.name] = async (input) => {
      if (faults.toolErrorOnce === s.tool.name) {
        faults.toolErrorOnce = undefined;
        throw Object.assign(new Error(`${s.tool.name}: upstream schema mismatch`), { kind: "tool_error" });
      }
      for (const d of s.downstream) {
        const client = clients[d.service];
        const r = d.method === "GET" ? await client.get(d.path) : await client.post(d.path, input, { idempotencyKey: `${s.tool.name}:${input.member_id}` });
        if (r.status >= 400) throw new Error(`${d.service} returned ${r.status}`);
      }
      return s.tool.result;
    };
  }
  return tools;
}

function routesFor(service: Downstream["service"]) {
  const table = new Map<string, HttpResult>();
  for (const s of STEPS) for (const d of s.downstream) if (d.service === service) table.set(`${d.method} ${d.path}`, { status: d.status, body: d.body });
  return (method: string, path: string) => table.get(`${method} ${path}`);
}

const LATENCY: Record<Downstream["service"], number> = {
  "claims-api": 180,
  "provider-directory": 120,
  "um-task-api": 220,
  "notify-api": 140,
  "crm-api": 90,
};

/** Wrap once at construction: model client, tools, downstream clients. */
export function buildAgent(opts: { wait: Wait; onGenerate?: (chunk: string) => void; faults?: Faults }): {
  agent: MemberLineAgent;
  provider: MockProvider;
} {
  // The scripted reply for each step is keyed by conversation length at that step.
  const byTurns = new Map<number, MockResponse>();
  let turns = 0;
  for (const line of SCRIPT) {
    if (line.who === "agent" && line.step) {
      const s = line.step;
      byTurns.set(turns, {
        thinking: s.thinking,
        say: s.say,
        tool: { name: s.tool.name, input: s.tool.input },
        decision: { ...s.decision, prompt_version: PROMPT_VERSION, member_id: MEMBER },
      });
    }
    turns++;
  }
  const respond = (req: unknown) => byTurns.get(((req as { messages?: unknown[] })?.messages ?? []).length);
  const provider = createMockProvider({ respond, wait: opts.wait, onGenerate: opts.onGenerate });
  const clients = {} as Clients;
  for (const service of Object.keys(LATENCY) as Downstream["service"][]) {
    clients[service] = traceDownstream(service, new MockService(routesFor(service), opts.wait, LATENCY[service]));
  }
  const agent = new MemberLineAgent(
    traceLLM(provider.client, { method: "messages.create", map: anthropicMap }),
    traceTools(makeTools(clients, opts.faults)),
  );
  return { agent, provider };
}
