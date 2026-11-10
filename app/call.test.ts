// End-to-end runs of the scripted call through the real signer process and a
// local authority: chain, anchoring, verification, commitments, completeness,
// tamper / drop / bypass detection, and each injected failure.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { startHarness, type Harness } from "./bench.js";
import { DisclosureStore, runCall, type CallResult, type FailureKind } from "./call.js";
import { checkIntegrity } from "./integrity.js";
import { STEPS } from "./scenario.js";
import { otel } from "./links.js";
import { aerfChainHash, verifyAerfReceipt } from "../src/receipt-aerf.js";
import { verifyAerfChain } from "../src/chain.js";
import { verifyDisclosure, saltedCommitment } from "../src/commitments.js";
import type { MockProvider } from "./mock.js";
import { attrsCommitment, type Span } from "./trace.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

type Ev = { event: string; data: Record<string, unknown> };

async function call(opts: { failures?: FailureKind[]; disclosures?: DisclosureStore; onProvider?: (p: MockProvider, raw: MockProvider["client"]) => void | Promise<void> } = {}) {
  const events: Ev[] = [];
  const result = await runCall({
    speed: 100,
    failures: new Set(opts.failures ?? []),
    signer: h.signer,
    logPublicKeyPem: h.authority.publicKeyPem,
    logId: h.authority.logId,
    authorityUrl: h.authorityUrl,
    emit: (event, data) => events.push({ event, data }),
    disclosures: opts.disclosures,
    links: [otel({ urlTemplate: "https://tempo.example.com/trace/{trace_id}?span={span_id}" })],
    authorityDownMs: 600,
    onProvider: opts.onProvider,
  });
  return { events, result, of: (name: string) => events.filter((e) => e.event === name).map((e) => e.data) };
}

function expectAllAnchoredAndVerified(r: CallResult, of: (n: string) => Record<string, unknown>[]) {
  expect(r.done.anchored).toBe(r.receipts.length);
  const verified = of("verified");
  expect(verified).toHaveLength(r.receipts.length);
  for (const v of verified) expect(v).toMatchObject({ issuer: true, log: "passed", chain_ok: true });
  const anchoredSeqs = of("anchored").map((a) => a.seq).sort((a, b) => Number(a) - Number(b));
  expect(anchoredSeqs).toEqual(r.receipts.map((x) => x.seq));
}

describe("scripted call, end to end", () => {
  let run: Awaited<ReturnType<typeof call>>;
  const disclosures = new DisclosureStore();
  beforeAll(async () => {
    run = await call({ disclosures });
  });

  it("produces a valid chain: one receipt per decision plus a close receipt, all anchored and verified", () => {
    const { result, of } = run;
    expect(result.receipts.map((r) => r.action)).toEqual([...STEPS.map((s) => `decide:${s.decision.point}`), "close:call"]);
    const chain = verifyAerfChain(result.receipts, { issuerPublicKey: h.signer.publicKeyPem });
    expect(chain.valid, chain.reason).toBe(true);
    expect(result.done.chain).toMatchObject({ valid: true, length: STEPS.length + 1 });
    expectAllAnchoredAndVerified(result, of);
    expect(result.integrity.ok).toBe(true);
    expect(result.reconciliation).toEqual({ provider_requests: STEPS.length, matched: STEPS.length, unmatched: [] });
    expect((result.done.consistency as { ok: boolean }).ok).toBe(true);
    for (const c of of("consistency")) expect(c.ok).toBe(true);
  });

  it("emits every contract event, with ids in order and spans before each signed", () => {
    const names = new Set(run.events.map((e) => e.event));
    for (const n of ["start", "turn", "model_input", "thinking", "tool_call", "tool_result", "decision", "span", "signed", "queued", "batch", "anchored", "verified", "consistency", "reconciled", "api", "done"]) {
      expect(names.has(n), n).toBe(true);
    }
    expect(run.events.at(-1)!.event).toBe("done");
    for (const e of run.events) expect(Number.isInteger(e.data.t_us)).toBe(true);
    const t = run.events.map((e) => e.data.t_us as number);
    expect([...t].sort((a, b) => a - b)).toEqual(t); // monotonic
    // For each step, all of its spans arrive before its signed event.
    for (let step = 0; step < STEPS.length; step++) {
      const signedAt = run.events.findIndex((e) => e.event === "signed" && e.data.step === step);
      const lastSpan = run.events.map((e, i) => [e, i] as const).filter(([e]) => e.event === "span" && e.data.step === step).at(-1)![1];
      expect(lastSpan).toBeLessThan(signedAt);
    }
  });

  it("every receipt's stack has a single root and valid parent links, and matches the streamed spans", () => {
    const spans = new Map(run.of("span").map((s) => [s.span_id as string, s]));
    for (const r of run.result.receipts.filter((x) => String(x.action).startsWith("decide:"))) {
      const stack = (r.evidence as { stack: { trace_id: string; spans: Array<Record<string, unknown>> } }).stack;
      expect(stack.trace_id).toMatch(/^[0-9a-f]{32}$/);
      const ids = new Set(stack.spans.map((s) => s.span_id));
      expect(stack.spans.filter((s) => s.parent_id === null)).toHaveLength(1);
      for (const s of stack.spans) {
        if (s.parent_id !== null) expect(ids.has(s.parent_id)).toBe(true);
        const streamed = spans.get(s.span_id as string)!;
        expect(streamed.attrs_sha256).toBe(s.attrs_sha256);
        // The page can recompute the salted attrs commitment from the streamed span.
        expect(attrsCommitment(streamed as unknown as Span)).toBe(s.attrs_sha256);
        expect(s.name).toBe(streamed.public_name);
      }
      expect(stack.spans.map((s) => s.kind)).toEqual(expect.arrayContaining(["turn", "llm.request", "llm.response", "tool.dispatch", "tool.exec", "downstream.call", "tool.result", "decision"]));
      const ev = r.evidence as { traceparent: string; links: Array<{ system: string; url: string }> };
      expect(ev.traceparent).toMatch(new RegExp(`^00-${stack.trace_id}-[0-9a-f]{16}-01$`));
      expect(ev.links[0]!.url).toContain(stack.trace_id);
    }
  });

  it("receipts carry only salted commitments; disclosures open them; claims are committed with cites only", () => {
    const thinking = STEPS.map((s) => s.thinking);
    for (const [i, r] of run.result.receipts.slice(0, STEPS.length).entries()) {
      const text = JSON.stringify(r);
      expect(text).not.toContain(thinking[i]!.slice(0, 40));
      expect(text).not.toContain("NH-552019");
      expect(r.commitment_alg).toBe("sha256-salted-v1");
      // A plain (unsalted) hash of the thinking does not match.
      expect(r.reasoning_hash).not.toBe(createHash("sha256").update(thinking[i]!).digest("hex"));
      const d = disclosures.get(r.id as string)!;
      expect(verifyDisclosure(r, d)).toEqual({ reasoning: "match", context: "match" });
      expect(verifyDisclosure(r, { ...d, reasoning: { salt: d.reasoning!.salt, text: d.reasoning!.text + " " } }).reasoning).toBe("mismatch");
      const ev = r.evidence as { claims_sha256: string; claim_cites: Array<{ id: string; cites: unknown[] }> };
      expect(ev.claims_sha256).toBe(saltedCommitment(d.claims!.salt, d.claims!.canonical));
      expect(ev.claim_cites.map((c) => c.id)).toEqual(STEPS[i]!.claims.map((c) => c.id));
      expect(JSON.stringify(ev.claim_cites)).not.toContain(STEPS[i]!.claims[0]!.text);
    }
    const dec = run.of("decision")[1]!;
    expect((dec.claims as unknown[]).length).toBe(STEPS[1]!.claims.length);
  });

  it("tamper: editing any signed field fails issuer and log verification", () => {
    const r = run.result.receipts[2]!;
    const opts = { issuerPublicKey: h.signer.publicKeyPem, logPublicKey: h.authority.publicKeyPem, requireLog: true };
    expect(verifyAerfReceipt(r, opts).ok).toBe(true);
    const ev = r.evidence as { decision_record: Record<string, unknown> };
    const tampered = { ...r, evidence: { ...ev, decision_record: { ...ev.decision_record, decision: "approved" } } };
    expect(verifyAerfReceipt(tampered, opts).ok).toBe(false);
    const chain = verifyAerfChain(run.result.receipts.map((x, i) => (i === 2 ? tampered : x)), { issuerPublicKey: h.signer.publicKeyPem });
    expect(chain).toMatchObject({ valid: false, breakAtIndex: 2 });
  });

  it("drop: a missing middle receipt, a missing last decision, and a missing close are all detected", () => {
    const rs = run.result.receipts;
    const hash = (r: Record<string, unknown>) => aerfChainHash(r);
    const middle = checkIntegrity(rs.filter((_, i) => i !== 4), hash);
    expect(middle.ok).toBe(false);
    expect(middle.missing_seqs).toEqual([5]);
    const lastDecision = checkIntegrity(rs.filter((_, i) => i !== rs.length - 2), hash);
    expect(lastDecision.ok).toBe(false);
    expect(lastDecision.tail_ok).toBe(false);
    expect(lastDecision.count_match).toBe(false);
    const noClose = checkIntegrity(rs.slice(0, -1), hash);
    expect(noClose).toMatchObject({ ok: false, close_present: false });
    expect(checkIntegrity(rs, hash).ok).toBe(true);
  });

  it("api events describe every authority interaction", () => {
    const api = run.of("api");
    const paths = api.map((a) => `${a.method} ${String(a.url).replace(/^https?:\/\/[^/]+/, "").split("?")[0]}`);
    expect(paths).toContain("POST /authority/v1/batches");
    expect(paths).toContain("GET /authority/v1/consistency");
    for (const a of api.filter((x) => String(x.url).includes("/batches"))) {
      expect(a.status).toBe(200);
      expect(typeof a.ms).toBe("number");
      expect((a.receipt_ids as string[]).length).toBeGreaterThan(0);
    }
  });
});

describe("bypass detection", () => {
  it("a model call made without traceLLM shows up as unmatched in reconciliation", async () => {
    let rawId: string | undefined;
    const { result, of } = await call({
      onProvider: async (provider, raw) => {
        await raw.messages.create({ messages: [] }); // straight to the provider, no wrapper
        rawId = provider.log.at(-1);
      },
    });
    expect(rawId).toMatch(/^req_/);
    expect(result.reconciliation.unmatched).toEqual([rawId]);
    expect(result.reconciliation.matched).toBe(STEPS.length);
    expect(of("reconciled")[0]).toMatchObject({ provider_requests: STEPS.length + 1, unmatched: [rawId] });
  });
});

describe("injected failures are captured, signed, and recovered", () => {
  const errorActions = (r: CallResult) => r.receipts.map((x) => String(x.action)).filter((a) => a.startsWith("error:"));

  it("llm_timeout: error span + error receipt, retry succeeds", async () => {
    const { result, of } = await call({ failures: ["llm_timeout"] });
    expect(errorActions(result)).toEqual(["error:llm_timeout"]);
    expect(of("span").some((s) => s.kind === "llm.request" && s.status === "error" && s.error_kind === "llm_timeout")).toBe(true);
    expect(of("failure")).toEqual([expect.objectContaining({ kind: "llm_timeout", attempt: 1, recovered: true })]);
    expect(result.integrity.ok && (result.done.chain as { valid: boolean }).valid).toBe(true);
    expectAllAnchoredAndVerified(result, of);
  });

  it("tool_error: tool.exec error span + error receipt, retry succeeds", async () => {
    const { result, of } = await call({ failures: ["tool_error"] });
    expect(errorActions(result)).toEqual(["error:tool_error"]);
    const err = result.receipts.find((r) => r.action === "error:tool_error")!;
    const stack = (err.evidence as { stack: { spans: Array<{ parent_id: string | null; status: string }> } }).stack;
    expect(stack.spans.filter((s) => s.parent_id === null)).toHaveLength(1);
    expect(stack.spans.some((s) => s.status === "error")).toBe(true);
    expect(of("failure")).toEqual([expect.objectContaining({ kind: "tool_error", recovered: true })]);
    expectAllAnchoredAndVerified(result, of);
  });

  it("authority_down: anchoring backs off and completes later with delayed=true; the call never waits", async () => {
    const { result, of } = await call({ failures: ["authority_down"] });
    expect(errorActions(result)).toEqual([]);
    expect(of("failure").filter((f) => f.kind === "authority_down" && f.recovered === false).length).toBeGreaterThan(0);
    expect(of("failure").some((f) => f.kind === "authority_down" && f.recovered === true)).toBe(true);
    expect(of("anchored").some((a) => a.delayed === true)).toBe(true);
    expectAllAnchoredAndVerified(result, of);
    expect(result.integrity.ok).toBe(true);
  });

  it("signer_crash: the in-flight decision is re-sent to the restarted signer; WAL keeps the chain gap-free", async () => {
    const { result, of } = await call({ failures: ["signer_crash"] });
    expect(errorActions(result)).toEqual(["error:signer_crash"]);
    expect(of("failure").map((f) => [f.kind, f.recovered])).toEqual([["signer_crash", false], ["signer_crash", true]]);
    const seqs = result.receipts.map((r) => r.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect((result.done.chain as { valid: boolean }).valid).toBe(true);
    expect(result.integrity.ok).toBe(true);
    expectAllAnchoredAndVerified(result, of);
  });
});
