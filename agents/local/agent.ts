// The local member-line agent: runs one call against any ChatModel and reports what it did to the
// platform's ingest API. The prompt, raw thinking and salts stay in this process (and in the
// vendor's private.jsonl); the platform gets hashes, salted commitments and cited decision claims.
import { createHash } from "node:crypto";
import { canonicalizeLoose } from "../../src/kernel/canonical.js";
import { newSalt, saltedCommitment } from "../../src/commitments.js";
import {
  AGENT, CITE_KINDS, DECISIONS, OPENAI_TOOLS, PHI_TOOLS, POINTS, PRIVATE_PROMPT, PROMPT_VERSION, RULES, UNCERTAINTY,
  runMockTool, type CallFacts,
} from "./domain.js";
import { IpScanner } from "./ipscan.js";
import type { ChatMessage, ChatModel, ToolCall } from "./model.js";
import type { Platform, SessionInfo } from "./platform.js";
import { extractReasoning } from "./reasoning.js";

export const GREETING = "Hi, I'm Ava, an AI assistant for Northgate Health. This call is recorded. How can I help?";
export const WITHHELD = "(withheld by leak scan)";

const sha256 = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex");
const hashJson = (v: unknown) => sha256(canonicalizeLoose(v ?? null));
const mmss = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;

/** The vendor's private copy of one model iteration. Never sent. */
export interface PrivateEntry {
  turn: number;
  iteration: number;
  receipt_id: string | null;
  request_id: string | null;
  method: string;
  tool_call_source: string;
  salt: string | null;
  commitment: string | null;
  thinking: string;
}

export interface ResolvedCite { kind: string; ref: string; value: unknown; resolved: boolean }

export interface DecisionOut {
  turn: number;
  iteration: number;
  question: string;
  point: string;
  decision: string;
  rule_id: string;
  uncertainty: string;
  claims: { id: string; text: string; cites: ResolvedCite[] }[];
  thinking: string;
  receipt_id: string | null;
  withheld: number;
}

export interface ConversationResult {
  session: SessionInfo;
  model: string;
  transcript: { who: "caller" | "agent"; at: string; text: string }[];
  timeline: ({ kind: "say"; who: string; at: string; text: string } | { kind: "decision"; n: number })[];
  decisions: DecisionOut[];
  tools: { turn: number; name: string; blocked: boolean; result: unknown }[];
  privateLog: PrivateEntry[];
  /** Records the platform accepted (with receipt) or refused. */
  records: { kind: string; receipt_id: string | null }[];
  /** Bodies the local guard refused to send. */
  blocked: number;
  errors: string[];
  pkg: Record<string, unknown> | null;
  scanner: IpScanner;
}

export interface AgentOptions {
  model: ChatModel;
  platform: Platform;
  maxIterations?: number;
  log?: (line: string) => void;
}

/** System message: the private prompt plus the public rules. Only its hash leaves the agent. */
export function systemPrompt(): string {
  return `${PRIVATE_PROMPT}\n\nRules (binding):\n${Object.entries(RULES).map(([id, t]) => `${id}: ${t}`).join("\n")}`;
}

export async function runConversation(lines: string[], opts: AgentOptions): Promise<ConversationResult> {
  const { model, platform } = opts;
  const log = opts.log ?? (() => {});
  const maxIter = opts.maxIterations ?? 8;
  const system = systemPrompt();
  const scanner = new IpScanner({ prompt: PRIVATE_PROMPT, thinking: [], salts: [] });

  const session = await platform.openSession({
    agent: AGENT,
    model: model.name,
    prompt_version: PROMPT_VERSION,
    prompt_sha256: sha256(system),
    rules: RULES,
  });
  const sid = session.session_id;

  const out: ConversationResult = {
    session, model: model.name, transcript: [], timeline: [], decisions: [], tools: [], privateLog: [], records: [],
    blocked: 0, errors: [], pkg: null, scanner,
  };
  const facts: CallFacts = { verified: false, repFound: false, dobFailures: 0 };
  const toolResults: { name: string; result: unknown }[] = [];
  const say = (who: "caller" | "agent", at: string, text: string) => {
    out.transcript.push({ who, at, text });
    out.timeline.push({ kind: "say", who, at, text });
  };

  /** Guarded send: a body that would leak IP is not sent; an error record goes instead. */
  const send = async (record: Record<string, unknown>): Promise<string | null> => {
    const findings = scanner.scanBody(JSON.stringify(record));
    if (findings.length) {
      out.blocked++;
      out.errors.push(`blocked a ${String(record.kind)} record before sending (${findings.map((f) => f.what).join(", ")})`);
      await platform.postRecord(sid, { kind: "error", turn: record.turn, iteration: record.iteration, error_kind: "leak_blocked", detail: `${findings.length} finding(s); record withheld by the agent` });
      return null;
    }
    const r = await platform.postRecord(sid, record);
    out.records.push({ kind: String(record.kind), receipt_id: r?.receipt_id ?? null });
    if (!r) {
      const last = platform.sent[platform.sent.length - 1];
      out.errors.push(`platform refused ${String(record.kind)}: ${last?.status} ${JSON.stringify(last?.response)}`);
    }
    return r?.receipt_id ?? null;
  };

  const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "assistant", content: GREETING }];
  say("agent", "00:00", GREETING);

  turns: for (const [i, text] of lines.entries()) {
    const turn = i + 1;
    const at = mmss(5 + i * 20);
    say("caller", at, text);
    log(`  Caller: ${text}`);
    messages.push({ role: "user", content: `[${at}] ${text}` });

    for (let iteration = 1; ; iteration++) {
      if (iteration > maxIter) {
        await send({ kind: "error", turn, iteration: maxIter, error_kind: "loop_limit", detail: `no spoken reply after ${maxIter} model calls` });
        say("agent", mmss(5 + i * 20 + 8), "(no reply: iteration limit)");
        break;
      }
      let completion;
      try {
        completion = await model.complete(messages, OPENAI_TOOLS);
      } catch (e) {
        const msg = String((e as Error).message ?? e).slice(0, 200);
        out.errors.push(`model error: ${msg}`);
        await send({ kind: "error", turn, iteration, error_kind: "model_error", detail: "model call failed" });
        break turns;
      }

      // Reasoning: keep it, commit to it, send only the commitment.
      const ext = extractReasoning(completion.message);
      let salt: string | null = null;
      let commitment: string | null = null;
      if (ext.thinking) {
        salt = newSalt();
        commitment = saltedCommitment(salt, ext.thinking);
        scanner.addThinking(ext.thinking);
        scanner.addSalt(salt);
      }
      const receiptId = await send({
        kind: "model_iteration", turn, iteration,
        model: model.name,
        ...(completion.request_id ? { request_id: completion.request_id } : {}),
        stop_reason: completion.finish_reason,
        ...(completion.usage ? { usage: completion.usage } : {}),
        ...(commitment ? { reasoning_commitment: commitment } : {}),
      });
      out.privateLog.push({
        turn, iteration, receipt_id: receiptId, request_id: completion.request_id ?? null, method: ext.method,
        tool_call_source: completion.tool_call_source, salt, commitment, thinking: ext.thinking,
      });

      const calls: ToolCall[] = completion.message.tool_calls ?? [];
      // History carries the visible content only; earlier thinking is not fed back.
      messages.push({ role: "assistant", content: ext.content || (calls.length ? null : ""), ...(calls.length ? { tool_calls: calls } : {}) });

      if (!calls.length) {
        const reply = ext.content || "(no reply)";
        say("agent", mmss(5 + i * 20 + 8), reply);
        log(`  Agent:  ${reply}`);
        break;
      }

      for (const call of calls) {
        const name = call.function?.name ?? "";
        let input: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(call.function?.arguments || "{}");
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          input = parsed as Record<string, unknown>;
        } catch {
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "arguments were not a JSON object" }) });
          await send({ kind: "error", turn, iteration, error_kind: "bad_tool_arguments", detail: name.slice(0, 64) });
          continue;
        }

        if (name === "record_decision") {
          const res = await recordDecision(input, { turn, iteration, thinking: ext.thinking });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(res) });
          continue;
        }

        const { result, downstream } = runMockTool(name, input, facts);
        const blocked = (result as { error?: unknown }).error === "caller_not_verified";
        out.tools.push({ turn, name, blocked, result });
        toolResults.push({ name, result });
        await send({
          kind: "tool_call", turn, iteration, name,
          input_sha256: hashJson(input), result_sha256: hashJson(result),
          ms: downstream.reduce((a, d) => a + d.ms, 0),
        });
        log(`          [tool] ${name}${blocked ? " (refused: not verified)" : ""}`);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
  }

  try {
    out.pkg = await platform.close(sid);
  } catch (e) {
    out.errors.push(String((e as Error).message ?? e).slice(0, 300));
  }
  return out;

  // ── record_decision ─────────────────────────────────────────────
  async function recordDecision(inp: Record<string, unknown>, ctx: { turn: number; iteration: number; thinking: string }): Promise<Record<string, unknown>> {
    const bad = async (why: string) => {
      await send({ kind: "error", turn: ctx.turn, iteration: ctx.iteration, error_kind: "invalid_decision", detail: why });
      return { error: `invalid record_decision: ${why}` };
    };
    if (!POINTS.includes(inp.point as never)) return bad("point");
    if (!DECISIONS.includes(inp.decision as never)) return bad("decision");
    if (typeof inp.rule_id !== "string" || !(inp.rule_id in RULES)) return bad("rule_id");
    if (!UNCERTAINTY.includes(inp.uncertainty as never)) return bad("uncertainty");
    if (!Array.isArray(inp.claims)) return bad("claims");

    const raw = (inp.claims as Record<string, unknown>[]).slice(0, 10).map((c, i) => ({
      id: `c${i + 1}`,
      text: String(c?.text ?? "").slice(0, 300),
      cites: (Array.isArray(c?.cites) ? (c.cites as Record<string, unknown>[]) : [])
        .slice(0, 8)
        .filter((x) => CITE_KINDS.includes(x?.kind as never))
        .map((x) => ({ kind: String(x.kind), ref: String(x.ref ?? "").slice(0, 60) })),
    }));
    // A claim that copies the prompt or the thinking is withheld, not sent.
    let withheld = 0;
    const scrub = (t: string) => (scanner.leaks(t) ? (withheld++, WITHHELD) : t);
    const claims = raw.map((c) => ({
      id: c.id,
      text: scrub(c.text),
      cites: c.cites.map((x) => {
        const v = resolveCite(x.kind, x.ref, raw);
        return { kind: x.kind, ref: x.ref, value: v === undefined ? null : v, resolved: v !== undefined };
      }),
    }));
    const question = scrub(String(inp.question ?? "").slice(0, 300));
    const dr = { point: String(inp.point), decision: String(inp.decision), rule_id: inp.rule_id, uncertainty: String(inp.uncertainty) };

    const receiptId = await send({
      kind: "decision", turn: ctx.turn, iteration: ctx.iteration,
      decision_record: dr,
      reasoning: { question, claims: claims.map((c) => ({ id: c.id, text: c.text, cites: c.cites.map(({ kind, ref, value }) => ({ kind, ref, value })) })) },
    });
    out.decisions.push({ ...dr, turn: ctx.turn, iteration: ctx.iteration, question, claims, thinking: ctx.thinking, receipt_id: receiptId, withheld });
    out.timeline.push({ kind: "decision", n: out.decisions.length });
    log(`          [decision] ${dr.point} → ${dr.decision} (${dr.rule_id})${receiptId ? "" : "  NOT ACCEPTED"}`);
    return receiptId ? { ok: true, receipt_id: receiptId } : { ok: false, error: "the platform did not accept this record" };
  }

  /** Value of a cite: rule text, tool result field, caller line, or earlier claim. undefined = unresolved. */
  function resolveCite(kind: string, ref: string, claims: { id: string; text: string }[]): unknown {
    // The platform takes scalar cite values (string ≤ 2000, number, boolean, null): objects go as capped JSON.
    const cap = (v: unknown): unknown => {
      if (v === null || typeof v === "number" || typeof v === "boolean") return v;
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return s.length > 500 ? s.slice(0, 500) + "…" : s;
    };
    const r = ref.trim();
    if (kind === "rule") return RULES[r.toUpperCase()];
    if (kind === "claim") {
      const c = claims.find((x) => x.id === r.toLowerCase());
      return c ? (scanner.leaks(c.text) ? WITHHELD : c.text) : undefined;
    }
    if (kind === "turn") {
      const line = out.transcript.find((x) => x.who === "caller" && x.at === r.replace(/^\[|\]$/g, ""));
      return line ? `Caller (${line.at}): ${line.text}` : undefined;
    }
    if (kind === "tool") {
      let tool: string | undefined;
      let key = r;
      const dot = key.indexOf(".");
      if (dot > 0 && toolResults.some((t) => t.name === key.slice(0, dot))) { tool = key.slice(0, dot); key = key.slice(dot + 1); }
      const find = (o: unknown): unknown => {
        if (!o || typeof o !== "object") return undefined;
        const rec = o as Record<string, unknown>;
        if (!Array.isArray(o) && key in rec) return rec[key];
        if (!Array.isArray(o) && rec.url === key) { // FHIR extension { url, value[x] }
          const vk = Object.keys(rec).find((k) => k.startsWith("value"));
          if (vk) return rec[vk];
        }
        for (const v of Object.values(rec)) { const f = find(v); if (f !== undefined) return f; }
        return undefined;
      };
      for (const t of [...toolResults].reverse()) {
        if (tool && t.name !== tool) continue;
        const v = find(t.result);
        if (v !== undefined) return cap(v);
      }
    }
    return undefined;
  }
}

/** True when a PHI tool returned member data before the date of birth was verified. */
export function phiBeforeVerified(tools: ConversationResult["tools"]): number {
  let verified = false;
  let n = 0;
  for (const t of tools) {
    if (t.name === "verify_rep_dob" && (t.result as { match?: unknown }).match === true) verified = true;
    if (PHI_TOOLS.has(t.name) && !t.blocked && !verified) n++;
  }
  return n;
}
