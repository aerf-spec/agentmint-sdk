// Salted commitments, close receipts, and trace links on the Notary.
import { describe, it, expect } from "vitest";
import { createHash, createPublicKey } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Notary, verifyClose } from "./notary.js";
import {
  SALTED_COMMITMENT_ALG,
  saltedCommitment,
  verifyDisclosure,
  type Disclosure,
} from "./commitments.js";
import { otelLinks, formatTraceparent } from "./trace-links.js";
import {
  verifyAerfReceipt,
  counterSignAerfReceipt,
  contextHashSha256,
  contextCanonical,
  AerfReceiptError,
} from "./receipt-aerf.js";
import { generateKeyPair, privateKeyToPem, publicKeyToPem } from "./kernel/sign.js";
import * as notarySubpath from "./exports/notary.js";
import * as root from "./index.js";

const planInit = { user: "admin@example.com", action: "handle-claims", scope: ["read:*", "submit:*"] };
const sha = (s: string): string => createHash("sha256").update(s, "utf-8").digest("hex");
const asRecord = (r: unknown): Record<string, unknown> => r as Record<string, unknown>;

describe("commitments: plain (default) is unchanged", () => {
  it("reasoning_hash / context_hash_sha256 are plain SHA-256 and no commitment_alg", () => {
    const notary = new Notary();
    const plan = notary.createPlan(planInit);
    const r = notary.notarise({
      action: "read:chart", agent: "a", plan, evidence: {}, reasoning: "why", context: { n: 1 },
    });
    expect(r.reasoning_hash).toBe(sha("why"));
    expect(r.context_hash_sha256).toBe(contextHashSha256({ n: 1 }));
    expect("commitment_alg" in r).toBe(false);
    expect(notary.disclosure(r.id)).toBeUndefined();
    // Plain receipts can still be opened with the text (salt ignored).
    expect(verifyDisclosure(r, { receipt_id: r.id, reasoning: { salt: "", text: "why" } }).reasoning).toBe("match");
  });
});

describe("commitments: salted", () => {
  const captured: Disclosure[] = [];
  const notary = new Notary({ commitments: "salted", disclosureSink: { emit: (d) => captured.push(d) } });
  const plan = notary.createPlan(planInit);
  const context = { patient: "p-1", age: 54, codes: ["E11.9"] };
  const r = notary.notarise({
    action: "read:chart", agent: "a", plan, evidence: { step: 1 }, reasoning: "A1c above threshold", context,
  });

  it("hashes are salted, the alg is signed, and salts are not on the receipt", () => {
    const d = notary.disclosure(r.id)!;
    expect(d.receipt_id).toBe(r.id);
    expect(d.reasoning!.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(d.context!.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(d.reasoning!.salt).not.toBe(d.context!.salt);
    expect(d.context!.canonical).toBe(contextCanonical(context));
    expect(r.reasoning_hash).toBe(sha(`${d.reasoning!.salt}:A1c above threshold`));
    expect(r.context_hash_sha256).toBe(sha(`${d.context!.salt}:${d.context!.canonical}`));
    expect(r.reasoning_hash).not.toBe(sha("A1c above threshold"));
    expect(r.commitment_alg).toBe(SALTED_COMMITMENT_ALG);
    expect(JSON.stringify(r)).not.toContain(d.reasoning!.salt);
    expect(JSON.stringify(r)).not.toContain(d.context!.salt);
    expect(notary.verifyReceipt(r)).toBe(true);
    // commitment_alg is signed: stripping or altering it breaks the signature.
    expect(notary.verifyReceipt({ ...r, commitment_alg: "sha256" })).toBe(false);
    const { commitment_alg: _drop, ...stripped } = r;
    expect(notary.verifyReceipt(stripped as typeof r)).toBe(false);
  });

  it("disclosure sink receives the same disclosure; mutating copies does not affect the notary", () => {
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual(notary.disclosure(r.id));
    captured[0]!.reasoning!.text = "tampered";
    notary.disclosure(r.id)!.reasoning!.text = "tampered";
    expect(notary.disclosure(r.id)!.reasoning!.text).toBe("A1c above threshold");
  });

  it("verifyDisclosure: match / mismatch / absent", () => {
    const d = notary.disclosure(r.id)!;
    expect(verifyDisclosure(r, d)).toEqual({ reasoning: "match", context: "match" });
    expect(verifyDisclosure(r, { receipt_id: r.id })).toEqual({ reasoning: "absent", context: "absent" });
    expect(verifyDisclosure(r, { ...d, reasoning: { ...d.reasoning!, text: "A1c below threshold" } }).reasoning).toBe("mismatch");
    expect(verifyDisclosure(r, { ...d, context: { ...d.context!, salt: d.reasoning!.salt } }).context).toBe("mismatch");
    expect(verifyDisclosure(r, { ...d, reasoning: { ...d.reasoning!, salt: "not-hex" } }).reasoning).toBe("mismatch");
    expect(verifyDisclosure(r, { ...d, receipt_id: "other" })).toEqual({ reasoning: "mismatch", context: "mismatch" });
    expect(verifyDisclosure({ ...r, commitment_alg: "unknown-v9" }, d).reasoning).toBe("mismatch");
  });

  it("each receipt gets fresh salts: identical reasoning commits differently", () => {
    const r2 = notary.notarise({ action: "read:chart", agent: "a", plan, evidence: { step: 2 }, reasoning: "A1c above threshold" });
    expect(r2.reasoning_hash).not.toBe(r.reasoning_hash);
    expect(notary.disclosure(r2.id)!.context).toBeUndefined();
    expect(verifyDisclosure(r2, notary.disclosure(r2.id)!)).toEqual({ reasoning: "match", context: "absent" });
  });

  it("receipts with nothing to commit carry no commitment_alg and no disclosure", () => {
    const r3 = notary.notarise({ action: "read:chart", agent: "a", plan, evidence: { step: 3 } });
    expect("commitment_alg" in r3).toBe(false);
    expect(notary.disclosure(r3.id)).toBeUndefined();
    expect(notary.verifyChain(plan.id).valid).toBe(true);
  });

  it("a throwing disclosure sink never blocks issuance", () => {
    const n = new Notary({ commitments: "salted", disclosureSink: { emit: () => { throw new Error("down"); } } });
    const p = n.createPlan(planInit);
    const rr = n.notarise({ action: "read:x", agent: "a", plan: p, evidence: {}, reasoning: "r" });
    expect(n.disclosure(rr.id)).toBeDefined();
  });

  it("rejects an unknown commitments mode", () => {
    expect(() => new Notary({ commitments: "fancy" as "plain" })).toThrow(AerfReceiptError);
  });

  it("saltedCommitment validates the salt", () => {
    expect(() => saltedCommitment("ab", "x")).toThrow(TypeError);
  });
});

describe("commitments: salted mode with impact tags (PDP + parent)", () => {
  it("PDP signs the salted context hash and the receipt verifies", () => {
    const pdp = generateKeyPair();
    const parent = generateKeyPair();
    const notary = new Notary({ commitments: "salted" });
    const plan = notary.createPlan(planInit);
    const r = notary.notarise({
      action: "submit:prior-auth", agent: "a", plan, evidence: { claim: "c-1" },
      impactTags: ["phi"], context: { member: "m-1", units: 3 }, reasoning: "criteria met",
      pdpPrivateKey: privateKeyToPem(pdp.privateKey),
    });
    expect(r.commitment_alg).toBe(SALTED_COMMITMENT_ALG);
    const signed = counterSignAerfReceipt(asRecord(r), privateKeyToPem(parent.privateKey));
    const res = verifyAerfReceipt(signed, {
      issuerPublicKey: notary.publicKeyPem,
      parentPublicKey: publicKeyToPem(parent.publicKey),
      pdpPublicKey: publicKeyToPem(createPublicKey(pdp.privateKey)),
    });
    expect(res.ok).toBe(true);
    expect(res.pdp).toBe("passed");
    expect(res.parent).toBe("passed");
    expect(verifyDisclosure(r, notary.disclosure(r.id)!)).toEqual({ reasoning: "match", context: "match" });
  });
});

describe("close receipts", () => {
  function closedChain() {
    const notary = new Notary();
    const plan = notary.createPlan(planInit);
    for (let i = 0; i < 3; i++) notary.notarise({ action: `submit:${i}`, agent: "a", plan, evidence: { i } });
    const close = notary.close(plan, { agent: "a", counts: { actions: 3, blocked: 0 } });
    return { notary, plan, close, receipts: notary.receipts(plan.id).map(asRecord) };
  }

  it("issues a chained, in-policy close receipt whose seq equals the chain length", () => {
    const { notary, plan, close, receipts } = closedChain();
    expect(close.action).toBe("close");
    expect(close.in_policy).toBe(true);
    expect(close.seq).toBe(4);
    expect(close.evidence).toEqual({ type: "chain_close", counts: { actions: 3, blocked: 0 }, receipts_before_close: 3 });
    expect(notary.verifyChain(plan.id).valid).toBe(true);
    const v = verifyClose(receipts, { issuerPublicKey: notary.publicKeyPem });
    expect(v.ok).toBe(true);
    expect(v.counts).toEqual({ actions: 3, blocked: 0 });
  });

  it("detects a dropped tail (including the close itself)", () => {
    const { notary, receipts } = closedChain();
    const noClose = verifyClose(receipts.slice(0, 3), { issuerPublicKey: notary.publicKeyPem });
    expect(noClose.ok).toBe(false);
    expect(noClose.reason).toMatch(/not a close receipt/);
    expect(verifyClose([], {}).ok).toBe(false);
  });

  it("detects a removed middle receipt (chain break) and a seq that does not match length", () => {
    const { notary, receipts } = closedChain();
    const gap = verifyClose([receipts[0]!, receipts[2]!, receipts[3]!], { issuerPublicKey: notary.publicKeyPem });
    expect(gap.ok).toBe(false);
    expect(gap.chain.valid).toBe(false);
    // Truncated head: links among the remaining receipts are fine but genesis/seq is not.
    expect(verifyClose(receipts.slice(1)).ok).toBe(false);
  });

  it("detects a tampered close receipt via the signature", () => {
    const { notary, receipts } = closedChain();
    const tampered = receipts.map((r, i) =>
      i === 3 ? { ...r, evidence: { ...(r.evidence as object), counts: { actions: 2, blocked: 0 } } } : r,
    );
    expect(verifyClose(tampered, { issuerPublicKey: notary.publicKeyPem }).ok).toBe(false);
  });

  it("refuses receipts after close and validates counts", () => {
    const { notary, plan } = closedChain();
    expect(() => notary.notarise({ action: "submit:x", agent: "a", plan, evidence: {} })).toThrow(/closed/);
    expect(() => notary.close(plan, { agent: "a", counts: {} })).toThrow(/closed/);
    const n = new Notary();
    const p = n.createPlan(planInit);
    expect(() => n.close(p, { agent: "a", counts: { x: 1.5 } })).toThrow(AerfReceiptError);
    expect(() => n.close(p, { agent: "a", counts: { x: -1 } })).toThrow(AerfReceiptError);
    // A close-only chain is valid: seq 1, length 1.
    n.close(p, { agent: "a", counts: { actions: 0 } });
    expect(verifyClose(n.receipts(p.id), { issuerPublicKey: n.publicKeyPem }).ok).toBe(true);
  });

  it("closed state persists across restarts with a stateDir", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-close-"));
    try {
      const key = privateKeyToPem(generateKeyPair().privateKey);
      const first = new Notary({ stateDir: dir, privateKeyPem: key });
      const plan = first.createPlan(planInit);
      first.close(plan, { agent: "a", counts: {} });
      const second = new Notary({ stateDir: dir, privateKeyPem: key });
      expect(() => second.notarise({ action: "submit:x", agent: "a", plan, evidence: {} })).toThrow(/closed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("trace links", () => {
  const trace = { trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", span_id: "00f067aa0ba902b7", request_id: "req-1" };

  it("adds a signed traceparent and links from plugins", () => {
    const seen: unknown[] = [];
    const notary = new Notary({
      traceLinks: [
        otelLinks({ urlTemplate: "https://traces.example.internal/t/{trace_id}?span={span_id}" }),
        { system: "noop", link: () => undefined },
        { system: "broken", link: () => { throw new Error("x"); } },
        { system: "spy", link: (ctx) => { seen.push(ctx); return undefined; } },
      ],
    });
    const plan = notary.createPlan(planInit);
    const r = notary.notarise({ action: "read:x", agent: "a", plan, evidence: { k: 1 }, trace });
    expect(r.evidence).toEqual({
      k: 1,
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      links: [{ system: "otel", url: "https://traces.example.internal/t/4bf92f3577b34da6a3ce929d0e0e4736?span=00f067aa0ba902b7" }],
    });
    expect(seen).toEqual([{ ...trace, started_at: r.observed_at }]);
    expect(notary.verifyReceipt(r)).toBe(true);
  });

  it("traceparent without plugins; no links key when no plugin links; no trace = evidence untouched", () => {
    const notary = new Notary();
    const plan = notary.createPlan(planInit);
    const r = notary.notarise({ action: "read:x", agent: "a", plan, evidence: {}, trace });
    expect(r.evidence).toEqual({ traceparent: formatTraceparent(trace) });
    const plain = notary.notarise({ action: "read:x", agent: "a", plan, evidence: { k: 1 } });
    expect(plain.evidence).toEqual({ k: 1 });
  });

  it("validates W3C ids and refuses to overwrite evidence keys", () => {
    const notary = new Notary();
    const plan = notary.createPlan(planInit);
    const bad = [
      { trace_id: "0".repeat(32), span_id: trace.span_id },
      { trace_id: trace.trace_id.toUpperCase(), span_id: trace.span_id },
      { trace_id: trace.trace_id.slice(1), span_id: trace.span_id },
      { trace_id: trace.trace_id, span_id: "0".repeat(16) },
      { trace_id: trace.trace_id, span_id: "xyz" },
    ];
    for (const t of bad) {
      expect(() => notary.notarise({ action: "read:x", agent: "a", plan, evidence: {}, trace: t })).toThrow(AerfReceiptError);
    }
    expect(() =>
      notary.notarise({ action: "read:x", agent: "a", plan, evidence: { traceparent: "x" }, trace }),
    ).toThrow(/traceparent/);
    expect(notary.receipts(plan.id)).toHaveLength(0);
  });

  it("otelLinks requires a {trace_id} template", () => {
    expect(() => otelLinks({ urlTemplate: "https://x" })).toThrow(TypeError);
    expect(otelLinks({ urlTemplate: "u/{trace_id}", system: "jaeger" }).system).toBe("jaeger");
  });
});

describe("exports", () => {
  it("new symbols are on the ./notary subpath and not at the root", () => {
    for (const name of [
      "verifyDisclosure", "saltedCommitment", "SALTED_COMMITMENT_ALG", "otelLinks",
      "formatTraceparent", "verifyClose", "contextCanonical", "CLOSE_ACTION",
    ]) {
      expect(name in notarySubpath, name).toBe(true);
      expect(name in root, name).toBe(false);
    }
  });
});
