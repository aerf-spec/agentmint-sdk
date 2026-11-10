// Chain verification: three distinct break types, per-plan isolation,
// and shared-fixture agreement with the Python
// producer's verify_chain.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { verifyAerfChain, legacyChainHash } from "./chain.js";
import { buildAerfReceipt, aerfChainHash } from "./receipt-aerf.js";
import { generateKeyPair, privateKeyToPem, publicKeyToPem } from "./kernel/sign.js";
import { signPlan, evaluatePolicy, computePolicyHash, type PlanReceipt, type PlanInit } from "./plan.js";

const planInit = {
  user: "admin@example.com",
  action: "handle-claims",
  scope: ["submit:*", "read:*"],
};

/** Minimal issuer: signed plan + per-plan seq/previous-hash chain. */
class Issuer {
  private readonly key = generateKeyPair();
  readonly publicKeyPem = publicKeyToPem(this.key.publicKey);
  private readonly chains = new Map<string, Record<string, unknown>[]>();
  createPlan(init: PlanInit): PlanReceipt {
    const plan = signPlan(init, this.key.privateKey);
    this.chains.set(plan.id, []);
    return plan;
  }
  notarise(i: { action: string; agent: string; plan: PlanReceipt; evidence: Record<string, unknown> }): void {
    const list = this.chains.get(i.plan.id)!;
    const prev = list[list.length - 1];
    const ev = evaluatePolicy(i.action, i.agent, i.plan);
    const r = buildAerfReceipt(
      {
        planId: i.plan.id, agent: i.agent, action: i.action, inPolicy: ev.inPolicy, policyReason: ev.reason,
        evidence: i.evidence, seq: list.length + 1, previousReceiptHash: prev ? aerfChainHash(prev) : undefined,
        planSignature: i.plan.signature, policyHash: computePolicyHash(i.plan),
      },
      { issuerPrivateKey: this.key.privateKey },
    );
    list.push(r as unknown as Record<string, unknown>);
  }
  receipts(planId: string): Record<string, unknown>[] {
    return [...(this.chains.get(planId) ?? [])];
  }
  verifyChain(planId: string) {
    return verifyAerfChain(this.receipts(planId), { issuerPublicKey: this.publicKeyPem });
  }
}

function chained(notary: Issuer, planId: string): Record<string, unknown>[] {
  return notary.receipts(planId);
}

describe("verifyAerfChain break types", () => {
  const notary = new Issuer();
  const plan = notary.createPlan(planInit);
  for (let i = 0; i < 4; i++) {
    notary.notarise({ action: `submit:claim:${i}`, agent: "a", plan, evidence: { i } });
  }
  const receipts = chained(notary, plan.id);

  it("valid chain: reports length, root hash (§8.4 of the final receipt), seq intact", () => {
    const res = notary.verifyChain(plan.id);
    expect(res.valid).toBe(true);
    expect(res.length).toBe(4);
    expect(res.rootHash).toBe(aerfChainHash(receipts[3]!));
    expect(res.linkRule).toBe("aerf-spec");
  });

  it("signature_invalid: tampering is named as tampering, at the right index", () => {
    const tampered = receipts.map((r, i) => (i === 2 ? { ...r, in_policy: false } : r));
    const res = verifyAerfChain(tampered, { issuerPublicKey: notary.publicKeyPem });
    expect(res.valid).toBe(false);
    expect(res.breakAtIndex).toBe(2);
    expect(res.breakType).toBe("signature_invalid");
  });

  it("deletion: hash link breaks AND the reason names the seq gap", () => {
    const withoutMiddle = [receipts[0]!, receipts[2]!, receipts[3]!];
    const res = verifyAerfChain(withoutMiddle, { issuerPublicKey: notary.publicKeyPem });
    expect(res.valid).toBe(false);
    expect(res.breakAtIndex).toBe(1);
    expect(res.breakType).toBe("hash_link_mismatch");
    expect(res.reason).toContain("seq also gaps");
  });

  it("seq_gap: detected independently when hash links are consistent", () => {
    // A malicious issuer signs receipts whose links are correct but whose
    // seq skips 3 — only the monotonic seq catches this.
    const { privateKey } = generateKeyPair();
    const pem = privateKeyToPem(privateKey);
    const base = {
      planId: "p1",
      agent: "a",
      inPolicy: true,
      policyReason: "ok",
    };
    const r1 = buildAerfReceipt(
      { ...base, action: "one", evidence: { n: 1 }, seq: 1 },
      { issuerPrivateKey: pem },
    ) as unknown as Record<string, unknown>;
    const r2 = buildAerfReceipt(
      { ...base, action: "two", evidence: { n: 2 }, seq: 2, previousReceiptHash: aerfChainHash(r1) },
      { issuerPrivateKey: pem },
    ) as unknown as Record<string, unknown>;
    const r4 = buildAerfReceipt(
      { ...base, action: "four", evidence: { n: 4 }, seq: 4, previousReceiptHash: aerfChainHash(r2) },
      { issuerPrivateKey: pem },
    ) as unknown as Record<string, unknown>;
    const res = verifyAerfChain([r1, r2, r4]);
    expect(res.valid).toBe(false);
    expect(res.breakAtIndex).toBe(2);
    expect(res.breakType).toBe("seq_gap");
  });

  it("genesis_violation: first receipt must not carry previous_receipt_hash", () => {
    const res = verifyAerfChain([receipts[1]!], { issuerPublicKey: notary.publicKeyPem });
    expect(res.valid).toBe(false);
    expect(res.breakAtIndex).toBe(0);
    expect(res.breakType).toBe("genesis_violation");
  });

  it("empty chain is valid with length 0", () => {
    expect(verifyAerfChain([])).toEqual({ valid: true, length: 0, rootHash: "" });
  });
});

describe("per-plan chain isolation", () => {
  it("interleaved plans keep independent chains and seqs", () => {
    const notary = new Issuer();
    const a = notary.createPlan(planInit);
    const b = notary.createPlan({ ...planInit, action: "other" });
    notary.notarise({ action: "submit:1", agent: "x", plan: a, evidence: {} });
    notary.notarise({ action: "submit:2", agent: "x", plan: b, evidence: {} });
    notary.notarise({ action: "submit:3", agent: "x", plan: a, evidence: {} });
    notary.notarise({ action: "submit:4", agent: "x", plan: b, evidence: {} });

    for (const plan of [a, b]) {
      const res = notary.verifyChain(plan.id);
      expect(res.valid, res.reason).toBe(true);
      expect(res.length).toBe(2);
    }
    const chainA = chained(notary, a.id);
    const chainB = chained(notary, b.id);
    // Genesis in both; second receipt links within its own plan only.
    expect(chainA[0]!["previous_receipt_hash"]).toBeUndefined();
    expect(chainB[0]!["previous_receipt_hash"]).toBeUndefined();
    expect(chainA[1]!["previous_receipt_hash"]).toBe(aerfChainHash(chainA[0]!));
    expect(chainB[1]!["previous_receipt_hash"]).toBe(aerfChainHash(chainB[0]!));
    expect(chainA[1]!["seq"]).toBe(2);
    expect(chainB[1]!["seq"]).toBe(2);
  });
});

describe("shared fixtures with the Python producer's verify_chain", () => {
  const available =
    existsSync(".vendor/agentmint-python") &&
    spawnSync("python3", ["-c", "import nacl"], { encoding: "utf-8" }).status === 0;

  interface PyFixture {
    receipts: Record<string, unknown>[];
    public_key_pem: string;
    chain: { valid: boolean; length: number; root_hash: string };
    removed: { valid: boolean; break_at_index: number | null };
  }

  function pythonChain(): PyFixture {
    const script = `
import sys, json
sys.path.insert(0, ".vendor/agentmint-python")
from agentmint.notary import Notary, verify_chain, _public_key_pem
n = Notary()
plan = n.create_plan(user="admin@example.com", action="handle", scope=["submit:*"], ttl_seconds=300)
rs = [n.notarise(action=f"submit:claim:{i}", agent="worker", plan=plan,
                 evidence={"i": i}, enable_timestamp=False) for i in range(3)]
cv = verify_chain(rs)
removed = verify_chain([rs[0], rs[2]])
print(json.dumps({
    "receipts": [r.to_dict() for r in rs],
    "public_key_pem": _public_key_pem(n.verify_key),
    "chain": {"valid": cv.valid, "length": cv.length, "root_hash": cv.root_hash},
    "removed": {"valid": removed.valid, "break_at_index": removed.break_at_index},
}))
`;
    const r = spawnSync("python3", ["-c", script], { encoding: "utf-8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout) as PyFixture;
  }

  it.skipIf(!available)("a Python-produced chain verifies (legacy link rule) with matching root", () => {
    const fx = pythonChain();
    const res = verifyAerfChain(fx.receipts, {
      issuerPublicKey: fx.public_key_pem,
      acceptLegacyLinks: true,
    });
    expect(res.valid, res.reason).toBe(true);
    expect(res.length).toBe(fx.chain.length);
    expect(res.linkRule).toBe("python-legacy");
    // With the legacy rule our root hash IS Python's verify_chain root_hash.
    expect(res.rootHash).toBe(fx.chain.root_hash);
    expect(legacyChainHash(fx.receipts[2]!)).toBe(fx.chain.root_hash);
  });

  it.skipIf(!available)("both verifiers flag a removed middle receipt at the same index", () => {
    const fx = pythonChain();
    const res = verifyAerfChain([fx.receipts[0]!, fx.receipts[2]!], {
      issuerPublicKey: fx.public_key_pem,
      acceptLegacyLinks: true,
    });
    expect(res.valid).toBe(false);
    expect(fx.removed.valid).toBe(false);
    expect(res.breakAtIndex).toBe(fx.removed.break_at_index);
    expect(res.breakType).toBe("hash_link_mismatch");
  });

  it.skipIf(!available)("strict mode rejects the legacy link rule", () => {
    const fx = pythonChain();
    const res = verifyAerfChain(fx.receipts, { issuerPublicKey: fx.public_key_pem });
    expect(res.valid).toBe(false);
    expect(res.breakType).toBe("hash_link_mismatch");
  });
});
