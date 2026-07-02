// Signed-silence suite (Phase 2). Signed decision receipts turn an agent's
// silence into evidence: a killed run still emits receipts, a tampered field
// breaks the signature, and a DELETED receipt breaks the hash chain — the log
// can omit, the chain cannot.
import { describe, it, expect } from "vitest";
import { harden } from "../src/experimental/harden.js";
import { verifyDecisionReceipts } from "../src/receipt-decision.js";
import {
  generateKeyPair,
  privateKeyToPem,
  publicKeyToPem,
  verifyStripped,
} from "../src/kernel/sign.js";
import type { AgentMintConfig } from "../src/types.js";

function signingKeys(): { privateKeyPem: string; publicKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPair();
  return { privateKeyPem: privateKeyToPem(privateKey), publicKeyPem: publicKeyToPem(publicKey) };
}

const ok = async () => ({ ok: true });

describe("signed decision receipts", () => {
  it("(a) signs and verifies all receipts of a 6-call run", async () => {
    const { privateKeyPem, publicKeyPem } = signingKeys();
    const tools = harden(
      { lookup: ok },
      { signing: { privateKeyPem } } as AgentMintConfig,
    );

    for (let n = 0; n < 6; n++) await tools.lookup({ n });

    const receipts = tools.__receipts();
    expect(receipts.length).toBe(6);
    // Monotonic 1-based seq, all sharing one run_id.
    expect(receipts.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(receipts.map((r) => r.run_id)).size).toBe(1);
    // Genesis omits previous_receipt_hash; the rest carry one.
    expect(receipts[0]!.previous_receipt_hash).toBeUndefined();
    for (let i = 1; i < receipts.length; i++) {
      expect(typeof receipts[i]!.previous_receipt_hash).toBe("string");
    }
    // Every signature verifies individually...
    for (const r of receipts) {
      expect(verifyStripped(r as unknown as Record<string, unknown>, publicKeyPem, r.signature)).toBe(true);
    }
    // ...and the whole chain verifies.
    expect(tools.__verifyReceipts()).toEqual({ ok: true });
    expect(verifyDecisionReceipts(receipts, publicKeyPem)).toEqual({ ok: true });
  });

  it("(b) mutating a signed field of receipt 3 fails the signature at index 3", async () => {
    const { privateKeyPem, publicKeyPem } = signingKeys();
    const tools = harden({ lookup: ok }, { signing: { privateKeyPem } } as AgentMintConfig);
    for (let n = 0; n < 6; n++) await tools.lookup({ n });

    const receipts = tools.__receipts();
    // Tamper with a signed field (action) of receipt at index 3.
    receipts[3]!.action = "totally-different-action";

    const result = verifyDecisionReceipts(receipts, publicKeyPem);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(3);
    expect(result.reason).toMatch(/signature/i);
  });

  it("(c) DELETING receipt 3 breaks the chain at index 3 (signed-silence test)", async () => {
    const { privateKeyPem, publicKeyPem } = signingKeys();
    const tools = harden({ lookup: ok }, { signing: { privateKeyPem } } as AgentMintConfig);
    for (let n = 0; n < 6; n++) await tools.lookup({ n });

    // Silently remove the receipt at index 3.
    const withHole = [...tools.__receipts()];
    withHole.splice(3, 1);

    const result = verifyDecisionReceipts(withHole, publicKeyPem);
    expect(result.ok).toBe(false);
    // Detected by BOTH the broken hash link and the seq gap, at index 3.
    expect(result.brokenAt).toBe(3);
    expect(result.reason).toMatch(/prev_hash|deleted|seq gap/i);
  });

  it("(d) a blocked call yields in_policy:false with the rule name in policy_reason", async () => {
    const { privateKeyPem } = signingKeys();
    const tools = harden(
      { transfer: ok },
      { deny: ["transfer"], signing: { privateKeyPem } } as AgentMintConfig,
    );

    await tools.transfer({ amount: 1000 });

    const receipts = tools.__receipts();
    const blocked = receipts.find((r) => r.action === "transfer");
    expect(blocked).toBeDefined();
    expect(blocked!.in_policy).toBe(false);
    expect(blocked!.policy_reason).toMatch(/denied/);
    // The blocked call still produced a signed receipt.
    expect(typeof blocked!.signature).toBe("string");
  });

  it("(e) post-kill attempts (from 2A) produce receipts", async () => {
    const { privateKeyPem } = signingKeys();
    const tools = harden(
      { read: ok, exfiltrate: ok },
      { budget: 1, costEstimator: () => 1, signing: { privateKeyPem } } as AgentMintConfig,
    );

    await tools.read({}); // allowed, cost -> 1
    await tools.read({}); // killed (budget reached)
    await tools.exfiltrate({ dest: "attacker.example" }); // attempted_after_kill
    await tools.exfiltrate({ dest: "attacker.example" }); // attempted_after_kill

    const receipts = tools.__receipts();
    const attempts = receipts.filter((r) => r.action === "exfiltrate");
    expect(attempts.length).toBe(2);
    for (const a of attempts) {
      expect(a.in_policy).toBe(false);
      expect(a.policy_reason).toMatch(/run_killed/);
    }
    // A killed run's decision trail still verifies end to end.
    expect(tools.__verifyReceipts().ok).toBe(true);
  });
});
