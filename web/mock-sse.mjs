// Mock backend for public/index.html. Replays a contract-conformant (v1 + v1.1 + additions) event stream.
//   node mock-sse.mjs            → http://localhost:4173
//   /events?speed=1&fail=llm_timeout|tool_error|authority_down|signer_crash
// Receipts are really Ed25519-signed and chained; the authority keeps a real RFC 6962 log with audit paths.
// env: PORT, ANCHOR_DELAY_MS (extra authority latency, to force out-of-order anchoring).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign as edSign, verify as edVerify, randomUUID, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);
const ANCHOR_DELAY_MS = Number(process.env.ANCHOR_DELAY_MS ?? 0);
const AGENT = "ava-member-line";
// list prices, USD per token (per 1M: input 4.00, output 20.00, cache read 0.20, cache write 5.00)
const RECORDED_MODEL = "claude-opus-5-5";
const PRICE = { in: 4.0e-6, out: 20.0e-6, cacheRead: 0.2e-6, cacheWrite: 5.0e-6 };
const FAILS = ["llm_timeout", "tool_error", "authority_down", "signer_crash"];

const RULES = {
  "DISC-0": "Say you are an AI and that the call is recorded.",
  "ID-3": "Share PHI only with the member or an authorized representative on file.",
  "BEN-2": "If usage may be incomplete or conflicting, give the confirmed number and flag what is pending. Never guess.",
  "BEN-5": "Always state in-network vs out-of-network cost.",
  "NET-1": "When a provider is out of network, offer in-network alternatives.",
  "COST-1": "Cost figures are estimates; state what they are based on.",
  "PA-0": "The agent cannot approve care. Explain how the treating provider requests prior authorization.",
  "SMS-1": "Text PHI only with explicit consent, to a number on file.",
  "END-1": "Before ending, recap next steps and log the outcome.",
};
const PROMPT_VERSION = "member-line@14.2";
const PROMPT = `You are Ava, Northgate Health's member line assistant. Warm, brief, plain words.
Persona notes: mirror the caller's pace; never read more than two numbers in one sentence.
Escalation ladder: … (412 more lines of wording, examples and routing hints)`;
const M = "NH-552019";
const T = (kind, ref) => ({ kind, ref });
const ds = (service, method, route, template, ms) => ({ service, method, route, template, ms });

const SCRIPT = [
  { who: "agent", at: "00:02", text: "Hi, I'm Ava, an AI assistant for Northgate Health. This call is recorded. How can I help?" },
  { who: "caller", at: "00:09", text: "Hi. I'm calling about my wife Sarah's physical therapy. Her member ID is NH-552019." },
  { who: "agent", at: "00:16", step: {
    thinking: "Caller says he is calling about his wife, so he is not the member. ID-3: I can't share anything until I know he is an authorized representative. Check the member's authorized reps for a caller named James before saying anything about her plan.",
    tool: { name: "check_authorized_rep", input: { member_id: M, caller_first_name: "James" },
      result: { authorized: true, relationship: "spouse", on_file_since: "2025-03-14", verify_with: "caller_dob" },
      downstream: [ds("members-api", "GET", `/members/${M}/representatives`, "/members/{id}/representatives", 22)] },
    decision: { point: "identity", decision: "authorized_rep_found_pending_dob", rule_id: "ID-3", uncertainty: "none", evidence: [{ at: "00:09", speaker: "caller" }, { at: "00:16", speaker: "tool" }] },
    claims: [
      { id: "c1", text: "Caller is calling about his wife, so he is not the member.", cites: [T("turn", "00:09")] },
      { id: "c2", text: "No plan details until he is an authorized representative.", cites: [T("rule", "ID-3"), T("claim", "c1")] },
      { id: "c3", text: "The caller's name is James.", cites: [] },
      { id: "c4", text: "James is on file as Sarah's authorized rep (spouse); verify with DOB.", cites: [T("tool", "authorized"), T("tool", "relationship"), T("tool", "verify_with"), T("claim", "c3")] },
      { id: "c5", text: "Ask for his date of birth before sharing anything.", cites: [T("claim", "c2"), T("claim", "c4")] },
    ],
    say: "Thanks, James. You're listed as Sarah's authorized representative. Can you confirm your date of birth?" } },
  { who: "caller", at: "00:24", text: "March 3rd, 1984." },
  { who: "agent", at: "00:27", step: {
    thinking: "Caller gave a date of birth for himself. ID-3 needs the rep verified before any PHI, so check it against the authorized rep record. Don't repeat the date back.",
    tool: { name: "verify_rep_dob", input: { member_id: M, rep_first_name: "James", dob: { hashed: "sha256:2f4c0d1e8a" } },
      result: { match: true, method: "rep_dob", attempts: 1 },
      downstream: [ds("members-api", "POST", `/members/${M}/representatives/verify`, "/members/{id}/representatives/verify", 19)] },
    decision: { point: "dob_verification", decision: "rep_verified", rule_id: "ID-3", uncertainty: "none", evidence: [{ at: "00:24", speaker: "caller" }, { at: "00:27", speaker: "tool" }] },
    claims: [
      { id: "c1", text: "Caller gave his date of birth.", cites: [T("turn", "00:24")] },
      { id: "c2", text: "PHI only after the rep is verified.", cites: [T("rule", "ID-3")] },
      { id: "c3", text: "The DOB matches the rep record.", cites: [T("tool", "match"), T("claim", "c1")] },
      { id: "c4", text: "James is verified; go ahead.", cites: [T("claim", "c2"), T("claim", "c3")] },
    ],
    say: "Thanks, James, you're verified. What can I help with?" } },
  { who: "caller", at: "00:30", text: "How many PT visits does she have left this year? And is Bayview Physical Therapy covered?" },
  { who: "agent", at: "00:36", step: {
    thinking: "Two questions: visits left, and Bayview's network status. Eligibility shows a 20-visit annual limit with 17 used on processed claims. There is also 1 visit pending adjudication that isn't counted yet. BEN-2: give the confirmed number and flag what's pending, so 2 remaining, possibly 1 once that claim processes.",
    tool: { name: "lookup_benefits", input: { member_id: M, benefit: "physical_therapy", year: 2026 },
      result: {
        insurance: [{ coverage: { reference: `Coverage/${M}` }, inforce: true, item: [{ category: { coding: [{ code: "physical_therapy" }] }, network: { coding: [{ code: "in" }] }, unit: { coding: [{ code: "individual" }] }, term: { coding: [{ code: "annual" }] },
          benefit: [{ type: { coding: [{ code: "visit" }] }, allowedUnsignedInt: 20, usedUnsignedInt: 17 }] }] }],
        outcome: "complete",
        pending_claims: [{ service_date: "2026-11-04", status: "pending_adjudication", units: 1 }],
      },
      downstream: [ds("eligibility-api", "POST", "/CoverageEligibilityRequest/$submit", "/CoverageEligibilityRequest/$submit", 38), ds("claims-api", "GET", `/members/${M}/claims?status=pending&benefit=pt`, "/members/{id}/claims", 17)] },
    decision: { point: "visits_remaining", decision: "remaining_2_pending_1_flagged", rule_id: "BEN-2", uncertainty: "claims_lag", evidence: [{ at: "00:30", speaker: "caller" }, { at: "00:36", speaker: "tool" }] },
    claims: [
      { id: "c1", text: "Two questions: visits left, and Bayview's network status.", cites: [T("turn", "00:30")] },
      { id: "c2", text: "Limit is 20 visits a year; 17 used on processed claims.", cites: [T("tool", "insurance")] },
      { id: "c3", text: "One more visit is pending adjudication and not counted yet.", cites: [T("tool", "pending_claims")] },
      { id: "c4", text: "Remaining is 2, possibly 1 once the pending claim processes.", cites: [T("claim", "c2"), T("claim", "c3")] },
      { id: "c5", text: "Give 2 as confirmed and flag the pending claim.", cites: [T("rule", "BEN-2"), T("claim", "c4")] },
    ],
    say: "She has 2 visits left on processed claims. One more visit is still being processed, so it may be 1 once that clears." } },
  { who: "agent", at: "00:48", step: {
    thinking: "Second question: Bayview. BEN-5 says always state in-network vs out-of-network cost, so check network status rather than just saying covered or not.",
    tool: { name: "check_network", input: { member_id: M, provider: "Bayview Physical Therapy" },
      result: { in_network: false, member_cost_out_of_network: "40% coinsurance", member_cost_in_network: "$30 copay" },
      downstream: [ds("provider-directory", "GET", "/providers?name=Bayview+Physical+Therapy", "/providers", 41)] },
    decision: { point: "network_cost", decision: "out_of_network_costs_stated", rule_id: "BEN-5", uncertainty: "none", evidence: [{ at: "00:30", speaker: "caller" }, { at: "00:48", speaker: "tool" }] },
    claims: [
      { id: "c1", text: "Second question: is Bayview covered.", cites: [T("turn", "00:30")] },
      { id: "c2", text: "Always state in-network vs out-of-network cost.", cites: [T("rule", "BEN-5")] },
      { id: "c3", text: "Bayview is out of network: 40% coinsurance, vs a $30 copay in network.", cites: [T("tool", "in_network"), T("tool", "member_cost_out_of_network"), T("tool", "member_cost_in_network")] },
      { id: "c4", text: "State both costs, not just covered or not.", cites: [T("claim", "c2"), T("claim", "c3")] },
    ],
    say: "Bayview is out of network, so she'd pay 40% coinsurance there, versus a $30 copay at an in-network clinic." } },
  { who: "caller", at: "00:58", text: "Is there an in-network place near us? We're in 94110." },
  { who: "agent", at: "01:03", step: {
    thinking: "Bayview is out of network and he wants an in-network option. NET-1: offer in-network alternatives. Search the directory for PT on her Gold PPO within 5 miles of 94110, and only list clinics taking new patients.",
    tool: { name: "find_providers", input: { specialty: "physical_therapy", zip: "94110", network: "Gold PPO", radius_mi: 5, accepting_new: true },
      result: { providers: [{ name: "Mission Street PT", distance_mi: 1.2, accepting: true }, { name: "Bernal Heights Rehab", distance_mi: 2.4, accepting: true }], searched: 14 },
      downstream: [ds("provider-directory", "GET", "/providers?specialty=pt&zip=94110&network=gold-ppo&radius=5", "/providers", 46)] },
    decision: { point: "in_network_alternatives", decision: "two_alternatives_offered", rule_id: "NET-1", uncertainty: "none", evidence: [{ at: "00:58", speaker: "caller" }, { at: "01:03", speaker: "tool" }] },
    claims: [
      { id: "c1", text: "He wants an in-network clinic near 94110.", cites: [T("turn", "00:58")] },
      { id: "c2", text: "Offer in-network alternatives.", cites: [T("rule", "NET-1")] },
      { id: "c3", text: "Mission Street PT (1.2 mi) and Bernal Heights Rehab (2.4 mi) are in network and taking patients.", cites: [T("tool", "providers")] },
      { id: "c4", text: "Offer both, nearest first.", cites: [T("claim", "c2"), T("claim", "c3")] },
    ],
    say: "Two in-network clinics are close: Mission Street PT, 1.2 miles away, and Bernal Heights Rehab, 2.4 miles. Both are taking new patients." } },
  { who: "caller", at: "01:12", text: "What would ten more visits cost at Mission Street?" },
  { who: "agent", at: "01:18", step: {
    thinking: "He wants a cost for ten visits at Mission Street. COST-1: give an estimate and say what it's based on. In network it's a $30 copay per visit with her deductible met, so about $300. Only 2 visits are left, possibly 1, so most of the 10 would need prior authorization; say that too.",
    tool: { name: "estimate_cost", input: { member_id: M, provider: "Mission Street PT", service: "97110", visits: 10 },
      result: { copay_per_visit: "$30", deductible_met: true, estimate_total: "$300", basis: "2026 Gold PPO in-network copay" },
      downstream: [ds("claims-api", "POST", "/estimates", "/estimates", 52)] },
    decision: { point: "cost_estimate", decision: "estimate_300_stated", rule_id: "COST-1", uncertainty: "estimate", evidence: [{ at: "01:12", speaker: "caller" }, { at: "00:36", speaker: "caller" }, { at: "01:18", speaker: "tool" }] },
    claims: [
      { id: "c1", text: "He asks what ten visits at Mission Street would cost.", cites: [T("turn", "01:12")] },
      { id: "c2", text: "In network it's a $30 copay per visit; deductible met.", cites: [T("tool", "copay_per_visit"), T("tool", "deductible_met")] },
      { id: "c3", text: "Ten visits come to about $300.", cites: [T("tool", "estimate_total"), T("claim", "c2")] },
      { id: "c4", text: "Only 2 visits remain, possibly 1, so most would need prior authorization.", cites: [T("turn", "00:36")] },
      { id: "c5", text: "Give about $300 as an estimate, state the basis, and flag the prior auth need.", cites: [T("rule", "COST-1"), T("tool", "basis"), T("claim", "c3"), T("claim", "c4")] },
    ],
    say: "At Mission Street it would be about $300 for ten visits, a $30 copay each, based on her plan's copay. Only 2 visits are covered now, possibly 1, so the rest would need prior authorization." } },
  { who: "caller", at: "01:30", text: "Can you just approve ten more visits for her?" },
  { who: "agent", at: "01:35", step: {
    thinking: "He asks me to approve ten more visits. PA-0: I can't approve care, and prior authorization has to be requested by the treating provider, not the member. Check what the plan needs for PT beyond the limit, then explain the process and offer to mail or text a letter explaining how.",
    tool: { name: "check_coverage_requirements", input: { member_id: M, service: "97110", provider: "Mission Street PT", requested_visits: 10 },
      result: { "coverage-information": [{ covered: "covered", "pa-needed": "auth-needed", "doc-needed": "clinical", "info-needed": "performer", reason: "Visits beyond the annual limit need prior authorization from the treating provider." }] },
      downstream: [ds("crd-service", "POST", "/cds-services/order-sign-crd", "/cds-services/{id}", 61)] },
    decision: { point: "approval_request", decision: "declined_explained_provider_pa", rule_id: "PA-0", uncertainty: "out_of_scope", evidence: [{ at: "01:30", speaker: "caller" }, { at: "01:35", speaker: "tool" }] },
    claims: [
      { id: "c1", text: "He asks me to approve ten more visits.", cites: [T("turn", "01:30")] },
      { id: "c2", text: "I cannot approve care.", cites: [T("rule", "PA-0")] },
      { id: "c3", text: "Extra visits are covered but need prior authorization.", cites: [T("tool", "coverage-information")] },
      { id: "c4", text: "The treating provider submits the request, not the member.", cites: [T("tool", "coverage-information"), T("rule", "PA-0")] },
      { id: "c5", text: "Decline, explain the provider must request it, and offer a letter explaining how.", cites: [T("claim", "c2"), T("claim", "c3"), T("claim", "c4")] },
    ],
    say: "I can't approve visits, and the prior authorization request has to come from her therapist's office. I can mail or text you a letter that explains how they submit it. Would that help?" } },
  { who: "caller", at: "02:02", text: "Yes, text me the letter and a summary. The number you have is fine." },
  { who: "agent", at: "02:07", step: {
    thinking: "He wants the letter and a summary by text and consents on the call. SMS-1: text PHI only with explicit consent, to a number on file. He said the number on file is fine, so send it there and record the consent turn.",
    tool: { name: "send_summary_sms", input: { member_id: M, to: "number_on_file", consent_at: "02:02", template: "pt_summary_and_pa_howto_letter" },
      result: { number_on_file: "***-***-4417", message_id: "SM-5521", status: "queued" },
      downstream: [ds("members-api", "GET", `/members/${M}/contacts?rep=james`, "/members/{id}/contacts", 18), ds("notify-api", "POST", "/sms", "/sms", 33)] },
    decision: { point: "sms_consent", decision: "summary_texted_with_consent", rule_id: "SMS-1", uncertainty: "none", evidence: [{ at: "02:02", speaker: "caller" }, { at: "02:07", speaker: "tool" }] },
    claims: [
      { id: "c1", text: "He asked for the letter and a summary by text, and consented to the number on file.", cites: [T("turn", "02:02")] },
      { id: "c2", text: "Text only with explicit consent, to a number on file.", cites: [T("rule", "SMS-1")] },
      { id: "c3", text: "Letter and summary queued to the number ending 4417.", cites: [T("tool", "number_on_file"), T("tool", "message_id"), T("tool", "status")] },
      { id: "c4", text: "Confirm the text is on its way.", cites: [T("claim", "c1"), T("claim", "c2"), T("claim", "c3")] },
    ],
    say: "Done. The letter and a summary are on their way to the number ending in 4417." } },
  { who: "caller", at: "02:14", text: "That's everything, thanks." },
  { who: "agent", at: "02:18", step: {
    thinking: "He's done. END-1: recap next steps before ending and log the outcome. Log the case with the text, then recap: 2 visits left, possibly 1; her therapist's office requests prior authorization; letter sent.",
    tool: { name: "log_call_outcome", input: { member_id: M, outcome: "resolved_provider_pa_explained", tasks: ["SM-5521"] },
      result: { case_id: "CASE-30917", logged: true },
      downstream: [ds("crm-api", "POST", "/cases", "/cases", 29)] },
    decision: { point: "close", decision: "recap_and_close", rule_id: "END-1", uncertainty: "none", evidence: [{ at: "02:14", speaker: "caller" }, { at: "02:18", speaker: "tool" }] },
    claims: [
      { id: "c1", text: "He has nothing else.", cites: [T("turn", "02:14")] },
      { id: "c2", text: "Recap next steps and log the outcome before ending.", cites: [T("rule", "END-1")] },
      { id: "c3", text: "Case CASE-30917 is logged with the text.", cites: [T("tool", "case_id"), T("tool", "logged")] },
      { id: "c4", text: "Recap and close the call.", cites: [T("claim", "c2"), T("claim", "c3")] },
    ],
    say: "To recap: 2 visits left, possibly 1. Her therapist's office requests prior authorization for more, and the letter explaining how is on its way. You're welcome, James. Take care." } },
];

// ── crypto helpers ──
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  : JSON.stringify(v);
const issuer = generateKeyPairSync("ed25519");
const authority = generateKeyPairSync("ed25519");
const keyIdOf = (k) => sha256(k.publicKey.export({ type: "spki", format: "der" })).slice(0, 16);
const ISSUER_KEY_ID = keyIdOf(issuer);
const LOG_ID = sha256(authority.publicKey.export({ type: "spki", format: "der" }));
const signedPayload = (r) => { const { signature, log_inclusion_proof, ...rest } = r; return Buffer.from(canonical(rest), "utf8"); };

// ── RFC 6962 log (global, grows across calls like the real authority) ──
const H = (...bufs) => createHash("sha256").update(Buffer.concat(bufs)).digest();
const leafHash = (data) => H(Buffer.from([0]), data);
const nodeHash = (l, r) => H(Buffer.from([1]), l, r);
const LOG = []; // Buffer leaf hashes
const split = (n) => { let k = 1; while (k * 2 < n) k *= 2; return k; };
function mth(lo, hi) { const n = hi - lo; if (n === 1) return LOG[lo]; const k = split(n); return nodeHash(mth(lo, lo + k), mth(lo + k, hi)); }
function auditPath(m, lo, hi) { // bottom-up siblings
  const n = hi - lo; if (n === 1) return [];
  const k = split(n);
  return m < k ? [...auditPath(m, lo, lo + k), { hash: mth(lo + k, hi).toString("hex"), side: "right" }]
               : [...auditPath(m - k, lo + k, hi), { hash: mth(lo, lo + k).toString("hex"), side: "left" }];
}
function rootFromPath(leaf, path) { let h = leaf; for (const p of path) h = p.side === "right" ? nodeHash(h, Buffer.from(p.hash, "hex")) : nodeHash(Buffer.from(p.hash, "hex"), h); return h.toString("hex"); }
let BATCH_N = 0;

const DISCLOSE = new Map(); // receipt_id → {salt, text}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function runCall(res, speed, fail, live) {
  const t0 = process.hrtime.bigint();
  const now = () => Number((process.hrtime.bigint() - t0) / 1000n);
  let eid = 0, closed = false;
  res.on("close", () => { closed = true; });
  const send = (event, data) => { if (closed) return; res.write(`id: ${++eid}\nevent: ${event}\ndata: ${JSON.stringify({ ...data, t_us: data.t_us ?? now() })}\n\n`); };
  const wait = (ms) => sleep(ms / speed);
  const ping = setInterval(() => !closed && res.write(": ping\n\n"), 15000);

  const planId = randomUUID(), sessionId = randomUUID(), traceId = randomBytes(16).toString("hex");
  const policyHash = sha256(canonical({ scope: ["decide:*"], agent: AGENT }));
  const planSig = edSign(null, Buffer.from(planId), issuer.privateKey).toString("hex");
  const spanId = () => randomBytes(8).toString("hex");
  let seq = 0, prevHash = null, prevSth = null;
  const signUs = [], hotUs = [], anchorMs = [], seqs = [];
  let batches = 0, failures = 0, providerReqs = 0, llmSpans = 0, toolCalls = 0, decisions = 0, turns = 0;
  const firstTree = LOG.length;

  send("start", { rules: RULES, prompt_version: PROMPT_VERSION, issuer_key_id: ISSUER_KEY_ID, log_id: LOG_ID, plan_id: planId, key_isolated: true, ...(live ? { model: "mock (scripted)" } : {}) });
  let lastCallerAt = null, callUsd = 0, callTok = 0, firstCall = true;

  // ── signer (hot path) ──
  function signReceipt(step, action, evidence, reasoning, context) {
    const h0 = process.hrtime.bigint();
    seq += 1;
    let reasoning_hash, disclosure;
    if (reasoning !== undefined) {
      const salt = randomBytes(16).toString("hex");
      reasoning_hash = sha256(`${salt}:${reasoning}`);
      evidence = { ...evidence, commitment_alg: "sha256(salt:text)" };
      disclosure = { salt, text: reasoning };
    }
    const r = {
      id: randomUUID(), type: "notarised_evidence", plan_id: planId, agent: AGENT, action,
      in_policy: !action.startsWith("error:"), policy_reason: action.startsWith("error:") ? `error recorded: ${action.slice(6)}` : `matched scope ${action.startsWith("decide:") ? "decide:*" : action}`,
      evidence_hash_sha512: createHash("sha512").update(canonical(evidence)).digest("hex"), evidence,
      observed_at: new Date().toISOString().replace("Z", "000+00:00"), aiuc_controls: ["E015", "D003", "B001"],
      key_id: ISSUER_KEY_ID, agent_key_id: "", policy_hash: policyHash, session_id: sessionId,
      reasoning_hash, previous_receipt_hash: prevHash ?? undefined, plan_signature: planSig, seq,
      context_hash_sha256: context ? sha256(canonical(context)) : undefined,
    };
    if (disclosure) DISCLOSE.set(r.id, disclosure);
    const payload = signedPayload(r);
    const s0 = process.hrtime.bigint();
    r.signature = edSign(null, payload, issuer.privateKey).toString("hex");
    const sign_us = Number((process.hrtime.bigint() - s0) / 1000n);
    const hot_us = Number((process.hrtime.bigint() - h0) / 1000n);
    const receipt_hash = sha256(payload);
    const previous = prevHash; prevHash = receipt_hash;
    signUs.push(sign_us); hotUs.push(hot_us); seqs.push(seq);
    send("signed", { step, seq, receipt_id: r.id, receipt_hash, previous_receipt_hash: previous, key_id: ISSUER_KEY_ID, signature: r.signature, sign_us, hot_us, receipt: r });
    const leaf = leafHash(payload);
    queue.push({ r, step, seq, at: Date.now(), payload, leaf, previous });
    send("queued", { step, receipt_id: r.id, seq, leaf_hash: leaf.toString("hex"), queue_depth: queue.length });
    return r;
  }

  // ── batcher (cold path): every 250 ms or 64 leaves ──
  const queue = [];
  let inflight = false, authorityFails = fail === "authority_down" ? 4 : 0, authAttempt = 0, retryAt = 0, delayed = false;
  const story = (failure_id, step, span_id, kind, stage, state, attempt = 1) =>
    send("failure", { failure_id, step, span_id, kind, stage, state, attempt, recovered: state === "recovered" });
  async function flush() {
    if (inflight || !queue.length || closed || Date.now() < retryAt) return;
    inflight = true;
    const sealed_t_us = now();
    const items = queue.slice(0, 64);
    const sent_t_us = now();
    const a0 = Date.now();
    await sleep(15 + Math.random() * 25 + ANCHOR_DELAY_MS);
    if (authorityFails > 0) { // authority unreachable: leaves stay queued locally, retry with backoff 1s, 2s, 4s
      authorityFails--; authAttempt++; delayed = true;
      if (authAttempt === 1) {
        failures++;
        story("f-auth", null, null, "authority_down", "authority unreachable", "recovering", 1);
        story("f-auth", null, null, "authority_down", `receipts signed, queued locally (${queue.length})`, "recovering", 1);
        story("f-auth", null, null, "authority_down", "retrying in 1s, 2s, 4s", "recovering", 1);
      }
      retryAt = Date.now() + 1000 * 2 ** (authAttempt - 1); inflight = false; return;
    }
    if (authAttempt) { story("f-auth", null, null, "authority_down", `authority back · batch of ${items.length} anchored`, "recovered", authAttempt + 1); authAttempt = 0; }
    queue.splice(0, items.length);
    const before = LOG.length;
    for (const it of items) LOG.push(it.leaf);
    const size = LOG.length, root = mth(0, size).toString("hex");
    const sth = { tree_size: size, root_hash: root, timestamp: new Date().toISOString() };
    const sth_signature = edSign(null, Buffer.from(canonical(sth)), authority.privateKey).toString("hex");
    const batch_id = `b-${++BATCH_N}`; batches++;
    const authority_ms = Date.now() - a0;
    const idxs = items.map((_, i) => before + i);
    send("batch", { batch_id, leaf_hashes: items.map((it) => it.leaf.toString("hex")), seqs: items.map((it) => it.seq), sealed_t_us, sent_t_us,
      tree_size_before: before, tree_size_after: size, root_hash: root, sth, sth_signature, authority_ms, delayed });
    // consistency of new STH with previous (a fresh tree of the old size must reproduce the old root)
    send("consistency", { from_size: prevSth ? prevSth.tree_size : before, to_size: size, ok: !prevSth || mth(0, prevSth.tree_size).toString("hex") === prevSth.root_hash });
    prevSth = sth;
    for (const [i, it] of items.entries()) {
      const leaf_index = before + i, audit_path = auditPath(leaf_index, 0, size);
      const anchor_ms = Date.now() - it.at; anchorMs.push(anchor_ms);
      send("anchored", { step: it.step, seq: it.seq, receipt_id: it.r.id, batch_id, batch_size: items.length, batch_leaf_indexes: idxs, leaf_index,
        leaf_hash: it.leaf.toString("hex"), tree_size_before: before, tree_size: size, root_hash: root, sth, sth_signature, audit_path,
        anchor_ms, delayed, clock_skew_ms: Math.round(Math.random() * 30) });
      const issuerOk = edVerify(null, it.payload, issuer.publicKey, Buffer.from(it.r.signature, "hex"));
      const logOk = rootFromPath(it.leaf, audit_path) === root;
      send("verified", { step: it.step, seq: it.seq, receipt_id: it.r.id, issuer: issuerOk, log: logOk ? "passed" : "failed", chain_ok: (it.r.previous_receipt_hash ?? null) === it.previous });
    }
    delayed = false;
    inflight = false;
  }
  const batcher = setInterval(flush, 250);

  try {
    const transcript = [];
    let n = -1;
    for (const line of SCRIPT) {
      if (closed) break;
      if (!line.step) {
        let text = line.text;
        if (live && line.who === "caller") { text = await live.next(); if (text == null) break; }
        if (line.who === "caller") lastCallerAt = line.at;
        transcript.push({ at: line.at, who: line.who, text }); turns++;
        send("turn", { who: line.who, at: line.at, text });
        await wait(900); continue;
      }
      n++; const s = line.step; decisions++;
      const stack = [];
      const span = (o) => { stack.push(o); send("span", { step: n, ...o }); };
      const errorReceipt = (kind, span_id) => signReceipt(n, `error:${kind}`, { error_kind: kind, span_id, step: n, links: [{ system: "otel", url: `https://ui.honeycomb.io/northgate/datasets/member-line/trace?trace_id=${traceId}&span=${span_id}`, span_id }], traceparent: `00-${traceId}-${span_id}-01` });
      const rootId = spanId(), rootStart = now();
      let iteration = 0;
      const loop = (stop_reason, reqStart, input_tokens, output_tokens) => {
        send("loop", { step: n, turn: lastCallerAt, iteration: ++iteration, stop_reason,
          input_tokens, output_tokens, cache_read_tokens: 2048, ms: Math.round((now() - reqStart) / 1000), request_id: `req_${randomBytes(6).toString("hex")}` });
        const cw = firstCall ? 2048 : 0, cr = firstCall ? 0 : 2048; firstCall = false;
        const usd = +((input_tokens - 2048) * PRICE.in + cr * PRICE.cacheRead + cw * PRICE.cacheWrite + output_tokens * PRICE.out).toFixed(6);
        callUsd += usd; callTok += input_tokens + output_tokens;
        send("cost", { step: n, iteration, model: RECORDED_MODEL, input_tokens, output_tokens, cache_read_tokens: cr, cache_write_tokens: cw, usd });
      };
      send("model_input", { step: n, at: line.at, prompt_version: PROMPT_VERSION, prompt_sha256: sha256(PROMPT), prompt_preview: PROMPT,
        rules_in_context: Object.keys(RULES), transcript_turns: transcript.length });
      await wait(300);

      // llm.request (with retry)
      let llmId;
      for (let attempt = 1; ; attempt++) {
        const reqId = spanId(), reqStart = now(); providerReqs++; llmSpans++;
        const reqAttrs = { model: RECORDED_MODEL, prompt_sha256: sha256(PROMPT), input_tokens: 2412 + transcript.length * 31, attempt };
        const respId = spanId(), respStart = now();
        const chunks = s.thinking.match(/\S+\s*/g) ?? [];
        for (const chunk of chunks) { send("thinking", { step: n, chunk }); await wait(35); }
        span({ span_id: respId, parent_id: reqId, kind: "llm.response", name: "thinking + tool_use", start_us: respStart, dur_us: now() - respStart,
          attrs: { thinking_sha256: sha256(s.thinking), output_tokens: chunks.length * 2 + 40, stop_reason: "tool_use", tool_use: s.tool.name } });
        span({ span_id: reqId, parent_id: rootId, kind: "llm.request", name: "model.generate", start_us: reqStart, dur_us: now() - reqStart, attrs: reqAttrs, attempt });
        loop("tool_use", reqStart, reqAttrs.input_tokens, chunks.length * 2 + 40);
        llmId = reqId;
        break;
      }

      // tool
      await wait(250);
      toolCalls++;
      const dispId = spanId(), dispStart = now();
      send("tool_call", { step: n, name: s.tool.name, input: s.tool.input });
      for (let attempt = 1; ; attempt++) {
        const execId = spanId(), execStart = now();
        await sleep(2);
        for (const [di, d] of s.tool.downstream.entries()) {
          if (fail === "tool_error" && n === 2 && di === 0) {
            const badId = spanId(), badStart = now();
            await sleep(d.ms);
            span({ span_id: badId, parent_id: execId, kind: "downstream.call", name: `${d.service} ${d.method} ${d.route}`, start_us: badStart, dur_us: now() - badStart,
              attrs: { service: d.service, method: d.method, route: d.template, status: 503, idempotency_key: `idem-${traceId.slice(0, 8)}-${n}` }, status: "error", error_kind: "http_503", attempt: 1 });
            failures++;
            story("f-tool", n, badId, "tool_error", `${s.tool.name} · ${d.service} 503`, "recovering", 1);
            await wait(600);
            story("f-tool", n, badId, "tool_error", "retry with same idempotency key", "recovering", 2);
            await wait(400);
          }
          const dsId = spanId(), dsStart = now();
          await sleep(d.ms);
          span({ span_id: dsId, parent_id: execId, kind: "downstream.call", name: `${d.service} ${d.method} ${d.route}`, start_us: dsStart, dur_us: now() - dsStart,
            attrs: { service: d.service, method: d.method, route: d.template, status: 200, member_id: { hashed: sha256("NH-552019") } }, attempt: fail === "tool_error" && n === 2 && di === 0 ? 2 : 1 });
          if (fail === "tool_error" && n === 2 && di === 0) {
            story("f-tool", n, dsId, "tool_error", "succeeded on attempt 2", "recovered", 2);
            signReceipt(n, "error:tool_error", { error_kind: "tool_error", span_id: dsId, step: n, recovered: true, attempts: 2 });
          }
        }
        await sleep(3);
        span({ span_id: execId, parent_id: dispId, kind: "tool.exec", name: s.tool.name, start_us: execStart, dur_us: now() - execStart, attrs: { input_sha256: sha256(canonical(s.tool.input)), attempt }, attempt });
        break;
      }
      span({ span_id: dispId, parent_id: rootId, kind: "tool.dispatch", name: s.tool.name, start_us: dispStart, dur_us: now() - dispStart, attrs: { tool: s.tool.name } });
      await wait(250);
      const resStart = now();
      send("tool_result", { step: n, name: s.tool.name, result: s.tool.result });
      span({ span_id: spanId(), parent_id: rootId, kind: "tool.result", name: s.tool.name, start_us: resStart, dur_us: 180, attrs: { result_sha256: sha256(canonical(s.tool.result)) } });

      // model call #2: reads the tool result, writes the reply and the decision record
      await wait(200);
      if (fail === "llm_timeout" && n === 1) {
        const bad = spanId(), badStart = now(); providerReqs++; llmSpans++;
        await wait(1200);
        span({ span_id: bad, parent_id: rootId, kind: "llm.request", name: "model.generate", start_us: badStart, dur_us: 8_000_000, attrs: { model: RECORDED_MODEL, timeout_ms: 8000 }, status: "error", error_kind: "timeout", attempt: 1 });
        loop("timeout", badStart, 2412 + transcript.length * 31 + 180, 0);
        failures++;
        story("f-llm", n, bad, "llm_timeout", "model call #2 · timed out after 8.0s", "recovering", 1);
        await wait(700);
        story("f-llm", n, bad, "llm_timeout", "retry 1 of 2 · backing off 400ms", "recovering", 2);
        await wait(400);
        var llmRetryOf = bad;
      }
      { const r2 = spanId(), r2Start = now(); providerReqs++; llmSpans++;
        const in2 = 2412 + transcript.length * 31 + 180;
        await wait(450);
        span({ span_id: r2, parent_id: rootId, kind: "llm.request", name: "model.generate", start_us: r2Start, dur_us: now() - r2Start, attrs: { model: RECORDED_MODEL, input_tokens: in2, stop_reason: "end_turn" }, attempt: 1 });
        loop("end_turn", r2Start, in2, Math.round(s.say.length / 4) + 60);
        if (fail === "llm_timeout" && n === 1) {
          story("f-llm", n, r2, "llm_timeout", "retry succeeded", "recovered", 2);
          signReceipt(n, "error:llm_timeout", { error_kind: "llm_timeout", span_id: llmRetryOf, step: n, recovered: true, attempts: 2 });
        } }
      // decision
      await wait(250);
      const decStart = now();
      const decision_record = { schema: "decision-record/v0", ...s.decision, prompt_version: PROMPT_VERSION, member: { hashed: sha256("NH-552019") },
        ...(n === 0 ? { caller_dob: { dropped: true } } : {}) };
      send("decision", { step: n, decision_record, claims: s.claims });
      span({ span_id: spanId(), parent_id: rootId, kind: "decision", name: s.decision.point, start_us: decStart, dur_us: 95, attrs: { rule_id: s.decision.rule_id, decision: s.decision.decision } });
      span({ span_id: rootId, parent_id: null, kind: "turn", name: `${AGENT} ${line.at}`, start_us: rootStart, dur_us: now() - rootStart, attrs: { at: line.at, transcript_turns: transcript.length } });

      if (fail === "signer_crash" && n === 2) {
        failures++;
        story("f-sign", n, null, "signer_crash", "signer process exited", "recovering", 1);
        await wait(600);
        story("f-sign", n, null, "signer_crash", "call paused · nothing signed is lost", "recovering", 1);
        await wait(900);
        story("f-sign", n, null, "signer_crash", `signer restarted · WAL replayed to seq ${seq}`, "recovering", 2);
        await wait(400);
        signReceipt(n, "error:signer_crash", { error_kind: "signer_crash", step: n, recovered: true, wal_replayed_to: seq });
        story("f-sign", n, null, "signer_crash", "chain continues · no gap", "recovered", 2);
      }
      const links = [
        { system: "otel", url: `https://ui.honeycomb.io/northgate/datasets/member-line/trace?trace_id=${traceId}&span=${rootId}`, span_id: rootId },
        { system: "langfuse", url: `https://cloud.langfuse.com/project/member-line/traces/${traceId}?observation=${llmId}`, span_id: llmId },
      ];
      signReceipt(n, `decide:${s.decision.point}`, { decision_record, tool: s.tool.name, stack: { trace_id: traceId, spans: stackOut(stack) }, links, traceparent: `00-${traceId}-${rootId}-01` }, s.thinking, { prompt: PROMPT, transcript });
      await wait(400);
      transcript.push({ at: line.at, who: "agent", text: s.say }); turns++;
      send("turn", { who: "agent", at: line.at, text: s.say, step: n });
      await wait(900);
    }

    // drain the cold path, then reconcile + close
    while ((queue.length || inflight) && !closed) await sleep(50);
    send("reconciled", { provider_requests: providerReqs, matched: providerReqs, unmatched: [] });
    signReceipt(null, "close", { counts: { turns, decisions, receipts: seqs.length + 1, llm_requests: llmSpans, tool_calls: toolCalls, failures } });
    while ((queue.length || inflight) && !closed) await sleep(50);
    send("call_cost", { usd: +callUsd.toFixed(6), tokens: callTok, by_model: { [RECORDED_MODEL]: +callUsd.toFixed(6) } });
    send("done", {
      chain: { valid: true, length: seqs.length, rootHash: prevHash }, receipts: seqs.length, batches,
      sign_us_p50: pct(signUs, 0.5), sign_us_max: Math.max(...signUs), anchor_ms_p50: pct(anchorMs, 0.5), anchor_ms_max: Math.max(...anchorMs),
      latency: { hot_us_p50: pct(hotUs, 0.5), hot_us_p99: pct(hotUs, 0.99), hot_us_max: Math.max(...hotUs), anchor_ms_p50: pct(anchorMs, 0.5), anchor_ms_max: Math.max(...anchorMs) },
      consistency: { ok: true, from: firstTree, to: LOG.length },
      leak_scan: { ok: true, scanned_fields: seqs.length * 14, findings: 0 },
    });
  } finally {
    clearInterval(batcher); clearInterval(ping);
    if (!closed) res.end();
  }
}
function stackOut(stack) {
  return stack.map((s) => ({ span_id: s.span_id, parent_id: s.parent_id, kind: s.kind, name: s.name, dur_us: s.dur_us, attrs_sha256: sha256(canonical(s.attrs)), ...(s.status ? { status: s.status } : {}) }));
}

if (process.argv[2] === "--dump") {
  // node mock-sse.mjs --dump public/events.json : record one run per failure mode for the static fallback
  const { writeFileSync } = await import("node:fs");
  const record = (fail) => new Promise((resolve) => {
    const events = []; const handlers = {};
    const res = { writableEnded: false, on: (e, f) => { handlers[e] = f; }, write(chunk) {
      if (chunk.startsWith(":")) return;
      const o = {}; for (const line of chunk.trim().split("\n")) { const i = line.indexOf(": "); o[line.slice(0, i)] = line.slice(i + 2); }
      events.push({ id: Number(o.id), event: o.event, data: JSON.parse(o.data) });
    }, end() { resolve(events); } };
    runCall(res, 1, fail);
  });
  const modes = ["", ...FAILS];
  const runs = {}; const disclose = {};
  for (const [i, ev] of (await Promise.all(modes.map(record))).entries()) {
    runs[modes[i]] = ev;
    for (const e of ev) if (e.event === "signed" && DISCLOSE.has(e.data.receipt_id)) disclose[e.data.receipt_id] = DISCLOSE.get(e.data.receipt_id);
  }
  writeFileSync(process.argv[3] ?? join(here, "public", "events.json"), JSON.stringify({ version: 1, runs, disclose }));
  console.log("wrote", Object.fromEntries(Object.entries(runs).map(([k, v]) => [k || "none", v.length])));
  process.exit(0);
}

const SESSIONS = new Map();
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" };
createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  // live API: POST /call → {id}; GET /call/:id/events (SSE); POST /call/:id/turn {text}
  if (url.pathname === "/calls/costs") {
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ calls: [
      { id: "a1b2c3d4", started_at: "2026-11-10T19:02:11Z", turns: 7, usd: 0.0731, by_model: { "claude-opus-5-5": 0.0731 } },
      { id: "e5f6a7b8", started_at: "2026-11-10T19:40:52Z", turns: 4, usd: 0.0388, by_model: { "claude-opus-5-5": 0.0388 } }], total_usd: 0.1119 }));
  }
  if (req.method === "POST" && url.pathname === "/call") {
    const id = randomUUID().slice(0, 8);
    SESSIONS.set(id, { queue: [], waiter: null, buf: [], res: null, started: false, ended: false, endReq: false });
    return res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id }));
  }
  const cm = url.pathname.match(/^\/call\/([\w-]+)\/(events|turn|interrupt|end)$/);
  if (cm) {
    const sess = SESSIONS.get(cm[1]);
    if (!sess) return res.writeHead(404).end();
    if (cm[2] === "events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); res.flushHeaders();
      for (const chunk of sess.buf) res.write(chunk); // replay history (last_event_id=0)
      if (sess.ended) return res.end();
      sess.res = res;
      res.on("close", () => { if (sess.res === res) sess.res = null; });
      if (!sess.started) {
        sess.started = true;
        const sink = { on() {}, flushHeaders() {}, write(chunk) { sess.buf.push(chunk); if (sess.res && !sess.res.writableEnded) sess.res.write(chunk); },
          end() { sess.ended = true; sess.res?.end(); } };
        const next = () => new Promise((r) => { if (sess.queue.length) r(sess.queue.shift()); else if (sess.endReq) r(null); else sess.waiter = (t) => { sess.waiter = null; r(t); }; });
        runCall(sink, 1, null, { next }).catch((err) => { sink.write(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`); sink.end(); });
      }
      return;
    }
    if (cm[2] === "end") { sess.endReq = true; sess.waiter?.(null); return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true })); }
    if (cm[2] === "interrupt") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let text = ""; try { text = String(JSON.parse(body).text ?? "").slice(0, 500); } catch {}
      if (sess.waiter) sess.waiter(text); else sess.queue.push(text);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders();
    const speed = Math.min(10, Math.max(0.25, Number(url.searchParams.get("speed") ?? 1) || 1));
    const fail = FAILS.includes(url.searchParams.get("fail")) ? url.searchParams.get("fail") : null;
    runCall(res, speed, fail).catch((err) => { res.write(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`); res.end(); });
    return;
  }
  const m = url.pathname.match(/^\/disclose\/([\w-]+)$/);
  if (m) {
    const d = DISCLOSE.get(m[1]);
    res.writeHead(d ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(d ?? { error: "not found" }));
    return;
  }
  if (url.pathname === "/healthz") return res.end("ok");
  if (url.pathname === "/events.json") {
    try { res.writeHead(200, { "content-type": "application/json" }).end(readFileSync(join(here, "public", "events.json"))); }
    catch { res.writeHead(404).end(); }
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(join(here, "public", "index.html")));
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`mock: http://localhost:${PORT}`));
