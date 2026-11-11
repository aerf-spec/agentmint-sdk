// `--model mock`: a deterministic scripted model, so the whole flow runs with no model server
// (CI, sandboxes). It reads the conversation like a real model would, and answers with a reasoning
// block plus either a tool call, a record_decision call, or a spoken reply.
//
//   mock     reasoning inline as <think>…</think> in content (R1-distill / Qwen3 style)
//   mock-rc  reasoning in the separate reasoning_content field (LM Studio / DeepSeek style)
import type { ChatMessage, ChatModel, Completion, ToolCall } from "./model.js";

type Json = Record<string, any>;
interface Cite { kind: "turn" | "tool" | "rule" | "claim"; ref: string }
interface DecisionArgs {
  question: string;
  point: string;
  decision: string;
  rule_id: string;
  uncertainty: string;
  claims: { text: string; cites: Cite[] }[];
}

interface State {
  ts: string;
  text: string;
  memberId: string;
  firstName: string;
  verified: boolean;
  /** Member's first name, from the rep lookup. */
  memberFirst: string;
  /** Tool results since the caller's last line. */
  results: { name: string; result: Json }[];
  /** Decisions recorded since the caller's last line (point/decision). */
  decided: { point: string; decision: string }[];
}

interface Intent {
  /** Small talk: nothing to look up or decide. */
  none?: boolean;
  /** Same key = same intent (deduped within one caller line). */
  key: string;
  think: [tool: string, decide: string, reply: string];
  tool?: { name: string; args: Json };
  decide(r: Json | undefined): DecisionArgs | null;
  reply(r: Json | undefined): string;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20 };

export function parseDob(text: string): string | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return iso[0];
  const m = new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, "i").exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.toLowerCase()) + 1;
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

function parseCount(text: string): number {
  const d = /\b(\d{1,3})\b/.exec(text);
  if (d) return Number(d[1]);
  for (const [w, n] of Object.entries(NUMBERS)) if (new RegExp(`\\b${w}\\b`, "i").test(text)) return n;
  return 1;
}

function readState(messages: ChatMessage[]): State {
  const names = new Map<string, string>();
  let lastUser = -1;
  let memberId = "";
  let firstName = "";
  let verified = false;
  let memberFirst = "";
  messages.forEach((m, i) => {
    if (m.role === "user") {
      lastUser = i;
      const id = /\b([A-Z]{2}-\d{4,})\b/i.exec(m.content ?? "");
      if (id) memberId = id[1]!.toUpperCase();
      const name = /\b(?:this is|i'm|i am|my name is) ([A-Z]\w+)/i.exec(m.content ?? "");
      if (name) firstName = name[1]!;
    }
    for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name);
    if (m.role === "tool" && names.get(m.tool_call_id ?? "") === "verify_rep_dob" && parse(m.content).match === true) verified = true;
    if (m.role === "tool" && names.get(m.tool_call_id ?? "") === "check_authorized_rep") memberFirst = String(parse(m.content).member_first_name ?? memberFirst);
  });
  const user = messages[lastUser]?.content ?? "";
  const stamp = /^\[(\d{2}:\d{2})\]\s*/.exec(user);
  const results: State["results"] = [];
  const decided: State["decided"] = [];
  for (const m of messages.slice(lastUser + 1)) {
    for (const c of m.tool_calls ?? []) {
      if (c.function.name === "record_decision") { const a = parse(c.function.arguments); decided.push({ point: String(a.point), decision: String(a.decision) }); }
    }
    if (m.role !== "tool") continue;
    const name = names.get(m.tool_call_id ?? "") ?? "";
    if (name !== "record_decision") results.push({ name, result: parse(m.content) });
  }
  return { ts: stamp?.[1] ?? "00:00", text: user.slice(stamp?.[0].length ?? 0), memberId, firstName, verified, memberFirst: memberFirst || "the member", results, decided };
}

/** Visit counts from a FHIR CoverageEligibilityResponse. */
function usageOf(r: Json | undefined): { allowed: number; used: number; pending: boolean } {
  const b = r?.insurance?.[0]?.item?.[0]?.benefit?.[0] ?? {};
  return { allowed: Number(b.allowedUnsignedInt ?? 0), used: Number(b.usedUnsignedInt ?? 0), pending: /pending adjudication/.test(String(r?.disposition ?? "")) };
}

function parse(s: string | null): Json {
  try { return JSON.parse(s ?? "{}") as Json; } catch { return {}; }
}

const turn = (ts: string): Cite => ({ kind: "turn", ref: ts });
const tool = (ref: string): Cite => ({ kind: "tool", ref });
const rule = (ref: string): Cite => ({ kind: "rule", ref });
const claim = (ref: string): Cite => ({ kind: "claim", ref });

/** What the scripted model wants to do with the caller's latest line. */
function intentFor(s: State): Intent {
  const benefit = /chiropract/i.test(s.text) ? "chiropractic" : /mental/i.test(s.text) ? "mental_health" : /specialist/i.test(s.text) ? "specialist_visit" : "physical_therapy";
  const benefitWords = benefit.replace("_", " ");
  const t = s.text.toLowerCase();
  const who = s.firstName || "the caller";
  const notVerified = (question: string): Intent => ({
    key: "not_verified",
    think: [
      "",
      `Nobody has passed the birth date check on this call, so ${who} is not cleared for any plan details. I should log the refusal under the PHI rule and hold back the numbers.`,
      "Refusal logged. Keep it short and offer to retry the identity step.",
    ],
    decide: () => ({
      question,
      point: "identity", decision: "rep_not_verified", rule_id: "ID-3", uncertainty: "not_verified",
      claims: [
        { text: "The date of birth given did not match the record on file.", cites: [tool("verify_rep_dob.match")] },
        { text: "Member details can only go to a verified member or representative.", cites: [rule("ID-3"), claim("c1")] },
      ],
    }),
    reply: () => "We can sort this out: let's try the date of birth once more, or I can connect you with a specialist who can verify you another way. Until then I can't share plan details.",
  });

  if (/member id is/.test(t)) {
    return {
      key: "identity",
      think: [
        `Caller says he is ${who} and read out member ID ${s.memberId}. Before saying anything about the account I need the representative lookup.`,
        `Lookup came back: ${who} is on file, relationship spouse, challenge is his own birth date. Not cleared yet, so log that the rep was found but a DOB check is pending.`,
        "Logged. Now ask for the birth date, no first name yet, no plan details.",
      ],
      tool: { name: "check_authorized_rep", args: { member_id: s.memberId, caller_first_name: s.firstName } },
      decide: (r) => r?.authorized === true
        ? {
            question: "Can this caller discuss the member's account?",
            point: "identity", decision: "authorized_rep_found_pending_dob", rule_id: "ID-3", uncertainty: "not_verified",
            claims: [
              { text: `The caller gave the member ID ${s.memberId} and the first name ${s.firstName}.`, cites: [turn(s.ts)] },
              { text: "The caller is listed as an authorized representative.", cites: [tool("relationship"), tool("authorized")] },
              { text: "A date of birth check is required before any PHI is shared.", cites: [tool("verify_with"), rule("ID-3")] },
            ],
          }
        : {
            question: "Can this caller discuss the member's account?",
            point: "identity", decision: "member_not_found", rule_id: "ID-3", uncertainty: "not_verified",
            claims: [{ text: "No authorized match was found for the caller.", cites: [tool("authorized"), rule("ID-3")] }],
          },
      reply: (r) => r?.authorized === true
        ? `Thanks, I found ${s.memberFirst === "the member" ? "the account" : `${s.memberFirst}'s account`}. To finish the security check, what's your date of birth?`
        : "I couldn't match those details yet. Read me the member ID once more and I'll look again.",
    };
  }

  if (/date of birth is|born on|\bdob\b/.test(t)) {
    const dob = parseDob(s.text) ?? "";
    return {
      key: "dob",
      think: [
        `Birth date heard as ${dob || "unclear"}. Normalized to ISO for the verify tool, checking it against ${who}'s record for ${s.memberId}.`,
        "Verify tool answered. Whatever it says decides whether benefits can be discussed, so this is an ID-3 decision to log before replying.",
        "Logged the outcome. Reply accordingly and use his name only if it matched.",
      ],
      tool: { name: "verify_rep_dob", args: { member_id: s.memberId, rep_first_name: s.firstName, dob } },
      decide: (r) => r?.match === true
        ? {
            question: "Is the caller verified to hear the member's information?",
            point: "dob_verification", decision: "rep_verified", rule_id: "ID-3", uncertainty: "none",
            claims: [
              { text: "The caller stated a date of birth.", cites: [turn(s.ts)] },
              { text: "The date of birth matches the record on file.", cites: [tool("match")] },
              { text: "A verified representative may receive the member's PHI.", cites: [claim("c2"), rule("ID-3")] },
            ],
          }
        : {
            question: "Is the caller verified to hear the member's information?",
            point: "dob_verification", decision: "rep_not_verified", rule_id: "ID-3", uncertainty: "not_verified",
            claims: [
              { text: "The caller stated a date of birth.", cites: [turn(s.ts)] },
              { text: "It does not match the record on file.", cites: [tool("match")] },
              { text: "No PHI can be shared until identity is verified.", cites: [claim("c2"), rule("ID-3")] },
            ],
          },
      reply: (r) => r?.match === true
        ? `Thank you, ${s.firstName}, you're verified. What can I help you with on ${s.memberFirst}'s plan?`
        : "That date doesn't match our records. We can try it once more, or I can connect you with a specialist who can verify you another way.",
    };
  }

  if (/\bapprove\b/.test(t)) {
    if (!s.verified) return notVerified("Can the agent approve more visits?");
    const n = parseCount(s.text);
    return {
      key: "approve",
      think: [
        `${who} wants ${n} more PT visits approved. I have no authority to approve anything; first see what coverage says about that many visits.`,
        "CRD answer: auth-needed, clinical docs needed, the ask is beyond what is left. Decline the approval, point to the provider-submitted PA, offer a letter.",
        "Decision logged. Explain plainly and offer mail or portal for the letter.",
      ],
      tool: { name: "check_prior_auth", args: { member_id: s.memberId, benefit: "physical_therapy", requested_visits: n } },
      decide: () => ({
        question: `Can the agent approve ${n} more physical therapy visits?`,
        point: "approval_request", decision: "declined_provider_must_request_pa", rule_id: "PA-0", uncertainty: "none",
        claims: [
          { text: `The caller asked for ${n} more visits to be approved.`, cites: [turn(s.ts)] },
          { text: "Coverage requires prior authorization for this request.", cites: [tool("pa-needed")] },
          { text: "The treating provider must submit it with clinical notes.", cites: [tool("doc-needed"), tool("reason")] },
          { text: "The agent cannot approve care and must offer a letter instead.", cites: [rule("PA-0"), claim("c2")] },
        ],
      }),
      reply: () => "Here's how to get those visits: the treating therapist requests prior authorization and sends clinical notes. Approval isn't something I can grant myself. I can send a letter that walks you through it, by mail or portal. Which would you like?",
    };
  }

  if (/\b(yes|sure|please)\b/.test(t) && /\b(mail|letter|portal)\b/.test(t)) {
    if (!s.verified) return notVerified("Can the agent send the member a letter?");
    const delivery = /portal/.test(t) ? "portal" : "mail";
    return {
      key: "letter",
      think: [
        `Clear yes to the letter, by ${delivery}. That's the consent I was waiting for, so send it now.`,
        "Letter queued with an id and an arrival window. Log it as the follow-up to the PA decline.",
        "Logged. Confirm timing and recap the next step.",
      ],
      tool: { name: "send_pa_letter", args: { member_id: s.memberId, delivery } },
      decide: () => ({
        question: "Should the prior authorization letter be sent?",
        point: "approval_request", decision: "pa_letter_sent", rule_id: "PA-0", uncertainty: "none",
        claims: [
          { text: `The caller agreed to receive the letter by ${delivery}.`, cites: [turn(s.ts)] },
          { text: "The letter was sent.", cites: [tool("letter_id"), tool("expected")] },
        ],
      }),
      reply: (r) => `Done. The letter is on its way and should arrive in ${String(r?.expected ?? "a few days")}. Her therapist can use it to request the extra visits.`,
    };
  }

  const prov = /\b[Ii]s ([A-Z][\w'&. ]*?),? (?:covered|in[- ]network)/.exec(s.text);
  if (prov || /\bcovered\b|in[- ]network/.test(t)) {
    if (!s.verified) return notVerified("Is this provider covered?");
    const provider = prov?.[1]?.trim() ?? "the clinic";
    return {
      key: "network",
      think: [
        `${who} is asking about ${provider}. Need network status and both cost figures from the directory before answering.`,
        "Directory result is in. If it's out of network I owe both figures, the out-of-network share and the in-network copay, plus the closest in-network clinic from the list.",
        "Logged. Say both prices, the basis, and the nearby option.",
      ],
      tool: { name: "check_network", args: { member_id: s.memberId, provider } },
      decide: (r) => r?.in_network === false
        ? {
            question: `Is ${provider} covered, and what would the member pay?`,
            point: "network_cost", decision: "out_of_network_costs_stated", rule_id: "BEN-5", uncertainty: "none",
            claims: [
              { text: `${provider} is out of network.`, cites: [tool("in_network")] },
              { text: "Out of network the member pays coinsurance after the deductible.", cites: [tool("member_cost_out_of_network")] },
              { text: "In network the member pays a flat copay per visit.", cites: [tool("member_cost_in_network"), tool("estimate_basis")] },
              { text: "Nearby in-network clinics are available.", cites: [tool("in_network_alternatives"), rule("NET-1")] },
              { text: "Both costs must be stated.", cites: [rule("BEN-5"), claim("c2"), claim("c3")] },
            ],
          }
        : {
            question: `Is ${provider} covered, and what would the member pay?`,
            point: "network_cost", decision: "in_network_cost_stated", rule_id: "BEN-5", uncertainty: "none",
            claims: [
              { text: `${provider} is in network.`, cites: [tool("in_network")] },
              { text: "The member pays the in-network copay.", cites: [tool("member_cost_in_network"), rule("BEN-5")] },
            ],
          },
      reply: (r) => r?.in_network === false
        ? `Harbor Physical Therapy is in network about ${r.in_network_alternatives?.[0]?.distance_mi ?? 2} miles away, at ${r.member_cost_in_network}. ${provider} is out of network, so there it's ${r.member_cost_out_of_network}. Both are estimates from the ${r.estimate_basis}.`
        : `Yes, ${provider} is in network: ${r?.member_cost_in_network ?? "the usual copay"}, estimated from the ${r?.estimate_basis ?? "plan schedule"}.`,
    };
  }

  if (/\bvisits?\b/.test(t) && /\b(left|remaining)\b/.test(t)) {
    if (!s.verified) return notVerified("How many therapy visits are left?");
    return {
      key: "visits",
      think: [
        `${who} is verified now and wants the ${benefitWords} visit count for ${s.memberFirst}. Pull this year's benefit record before quoting anything.`,
        "Got the benefit record. Remaining is limit minus adjudicated use; if the disposition mentions a visit still waiting on adjudication, the honest move is to quote the confirmed remainder and flag that it may drop.",
        "Logged. Say the confirmed number and, if any, the caveat about the pending visit.",
      ],
      tool: { name: "lookup_benefits", args: { member_id: s.memberId, benefit, year: 2026 } },
      decide: (r) => {
        const u = usageOf(r);
        const claims = [
          { text: `The plan allows ${u.allowed} ${benefitWords} visits a year.`, cites: [tool("allowedUnsignedInt")] },
          { text: `${u.used} visits are confirmed as used.`, cites: [tool("usedUnsignedInt")] },
        ];
        if (u.pending) {
          claims.push({ text: "One more visit is still pending adjudication.", cites: [tool("disposition")] });
          claims.push({ text: `${u.allowed - u.used} visits are confirmed remaining, and the pending visit may lower that.`, cites: [claim("c1"), claim("c2"), claim("c3"), rule("BEN-2")] });
        } else {
          claims.push({ text: `${u.allowed - u.used} visits remain.`, cites: [claim("c1"), claim("c2"), rule("BEN-2")] });
        }
        return {
          question: `How many ${benefitWords} visits does the member have left this year?`,
          point: "visits_remaining", decision: u.pending ? "remaining_visits_flagged" : "remaining_visits_stated", rule_id: "BEN-2",
          uncertainty: u.pending ? "pending_claims" : "none", claims,
        };
      },
      reply: (r) => {
        const u = usageOf(r);
        const left = u.allowed - u.used;
        return u.pending
          ? `${s.memberFirst} has ${left} confirmed ${benefitWords} visits left this year. One recent visit is still being processed, so that may drop to ${left - 1}.`
          : `${s.memberFirst} has ${left} ${benefitWords} visits left this year.`;
      },
    };
  }

  return {
    none: true,
    key: "none",
    think: ["", "", "Nothing rule-governed here. Just ask what they need."],
    decide: () => null,
    reply: () => "I can help with benefits, network costs or prior authorization. What would you like to know?",
  };
}

/** One intent per clause of the caller's line ("…left, and is X in network?" is two). */
function intentsFor(s: State): Intent[] {
  const clauses = s.text.split(/[?.!]\s+|,?\s+and\s+(?=(?:is|are|can|what|how|could)\b)/i).filter((c) => c.trim());
  const out: Intent[] = [];
  for (const c of clauses) {
    const it = intentFor({ ...s, text: c });
    if (!it.none && !out.some((x) => x.key === it.key)) out.push(it);
  }
  return out.length ? out : [intentFor({ ...s, text: "" })];
}

export class MockModel implements ChatModel {
  private calls = 0;
  constructor(readonly name = "mock", private where: "think_tag" | "reasoning_content" = name === "mock-rc" ? "reasoning_content" : "think_tag") {}

  async complete(messages: ChatMessage[]): Promise<Completion> {
    const s = readState(messages);
    const intents = intentsFor(s);
    let think = "";
    let content = "";
    let call: { name: string; args: Json } | null = null;
    for (const it of intents) {
      const r = it.tool ? [...s.results].reverse().find((x) => x.name === it.tool!.name)?.result : undefined;
      if (it.tool && !r) { think = it.think[0]; call = it.tool; break; }
      const d = it.decide(r);
      if (d && !s.decided.some((x) => x.point === d.point && x.decision === d.decision)) { think = it.think[1]; call = { name: "record_decision", args: d }; break; }
    }
    if (!call) {
      think = intents[intents.length - 1]!.think[2];
      content = intents.map((it) => it.reply(it.tool ? [...s.results].reverse().find((x) => x.name === it.tool!.name)?.result : undefined)).join(" ");
    }

    const n = ++this.calls;
    const tool_calls: ToolCall[] | undefined = call
      ? [{ id: `call_mock_${n}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }]
      : undefined;
    const message: ChatMessage = this.where === "reasoning_content"
      ? { role: "assistant", content, reasoning_content: think, ...(tool_calls ? { tool_calls } : {}) }
      : { role: "assistant", content: `<think>\n${think}\n</think>\n\n${content}`, ...(tool_calls ? { tool_calls } : {}) };
    const inChars = messages.reduce((a, m) => a + (m.content?.length ?? 0), 0);
    return {
      request_id: `mock-${n}`,
      message,
      finish_reason: tool_calls ? "tool_calls" : "stop",
      usage: { input_tokens: Math.ceil(inChars / 4), output_tokens: Math.ceil((think.length + content.length + JSON.stringify(call?.args ?? "").length) / 4) },
      tool_call_source: tool_calls ? "native" : "none",
    };
  }
}
