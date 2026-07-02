// Full AERF evidence receipt: build, sign, verify, chain-hash semantics.
import { describe, it, expect } from "vitest";
import { createPublicKey } from "node:crypto";
import {
  buildAerfReceipt,
  buildAerfSignable,
  verifyAerfReceipt,
  aerfChainHash,
  evidenceHashSha512,
  attachLogInclusionProof,
  isoNowUtc,
  AerfReceiptError,
  AIUC_CONTROLS,
} from "./receipt-aerf.js";
import {
  generateKeyPair,
  publicKeyToPem,
  privateKeyToPem,
  keyId,
  signedPayloadBytes,
} from "./kernel/sign.js";
import { sha256Hex, canonicalBytes } from "./kernel/canonical.js";

function newKeys() {
  const { publicKey, privateKey } = generateKeyPair();
  return {
    publicKey,
    privateKey,
    publicKeyPem: publicKeyToPem(publicKey),
    privateKeyPem: privateKeyToPem(privateKey),
  };
}

const baseInit = {
  planId: "bc023208-ea24-410a-a280-ff36820e18a6",
  agent: "claims-agent",
  action: "submit:claim:CLM-9920",
  inPolicy: true,
  policyReason: "matched scope submit:claim:*",
  evidence: { tool: "submit-claim", claim_id: "CLM-9920", amount_micros: 1250000000 },
};

describe("buildAerfReceipt", () => {
  it("produces a signed receipt that verifies", () => {
    const issuer = newKeys();
    const receipt = buildAerfReceipt(baseInit, { issuerPrivateKey: issuer.privateKeyPem });

    expect(receipt.type).toBe("notarised_evidence");
    expect(receipt.key_id).toBe(keyId(issuer.publicKey));
    expect(receipt.agent_key_id).toBe("");
    expect(receipt.aiuc_controls).toEqual([...AIUC_CONTROLS]);
    expect(receipt.evidence_hash_sha512).toBe(evidenceHashSha512(baseInit.evidence));
    expect("previous_receipt_hash" in receipt).toBe(false);
    expect("mode" in receipt).toBe(false);

    const res = verifyAerfReceipt(receipt as unknown as Record<string, unknown>, {
      issuerPublicKey: issuer.publicKeyPem,
    });
    expect(res.ok).toBe(true);
    expect(res.issuerOk).toBe(true);
  });

  it("rejects a tampered signed field", () => {
    const issuer = newKeys();
    const receipt = buildAerfReceipt(baseInit, { issuerPrivateKey: issuer.privateKeyPem });
    const tampered = { ...receipt, in_policy: false } as unknown as Record<string, unknown>;
    const res = verifyAerfReceipt(tampered, { issuerPublicKey: issuer.publicKeyPem });
    expect(res.ok).toBe(false);
    expect(res.failCategory).toBe("issuer_signature");
  });

  it("omits conditional fields exactly like the Python producer", () => {
    const issuer = newKeys();
    const signable = buildAerfSignable(
      { ...baseInit, observedAt: isoNowUtc(), id: "r-1" },
      "kid",
    );
    // Python's signable_dict: base 13 keys when no conditionals fire.
    expect(Object.keys(signable).sort()).toEqual(
      [
        "id", "type", "plan_id", "agent", "action", "in_policy", "policy_reason",
        "evidence_hash_sha512", "evidence", "observed_at", "aiuc_controls",
        "key_id", "agent_key_id",
      ].sort(),
    );
    void issuer;
  });

  it("includes conditional fields when set, and mode only when not enforce", () => {
    const issuer = newKeys();
    const receipt = buildAerfReceipt(
      {
        ...baseInit,
        policyHash: "ab".repeat(32),
        outputHash: "cd".repeat(32),
        sessionId: "sess-1",
        sessionTrajectory: [
          { action: "a", agent: "claims-agent", in_policy: true, observed_at: isoNowUtc() },
        ],
        sessionEscalation: "escalate:submit:*:3/3",
        reasoningHash: "ef".repeat(32),
        mode: "shadow",
        originalVerdict: false,
        planSignature: "00".repeat(64),
        previousReceiptHash: "11".repeat(32),
      },
      { issuerPrivateKey: issuer.privateKeyPem },
    );
    expect(receipt.mode).toBe("shadow");
    expect(receipt.original_verdict).toBe(false);
    expect(receipt.previous_receipt_hash).toBe("11".repeat(32));
    expect(receipt.plan_signature).toBe("00".repeat(64));
    const res = verifyAerfReceipt(receipt as unknown as Record<string, unknown>, {
      issuerPublicKey: issuer.publicKeyPem,
    });
    expect(res.ok).toBe(true);
  });

  it("signs agent_signature over canonical(evidence) with the agent key", () => {
    const issuer = newKeys();
    const agent = newKeys();
    const receipt = buildAerfReceipt(baseInit, {
      issuerPrivateKey: issuer.privateKeyPem,
      agentPrivateKey: agent.privateKeyPem,
    });
    expect(receipt.agent_signature).toMatch(/^[0-9a-f]{128}$/);
    expect(receipt.agent_key_id).toBe(keyId(createPublicKey(agent.privateKeyPem)));

    const ok = verifyAerfReceipt(receipt as unknown as Record<string, unknown>, {
      issuerPublicKey: issuer.publicKeyPem,
      agentPublicKey: agent.publicKeyPem,
    });
    expect(ok.ok).toBe(true);
    expect(ok.agent).toBe("passed");

    // Wrong agent key → agent check fails.
    const wrong = verifyAerfReceipt(receipt as unknown as Record<string, unknown>, {
      issuerPublicKey: issuer.publicKeyPem,
      agentPublicKey: newKeys().publicKeyPem,
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.failCategory).toBe("agent_signature");
  });

  it("validates action/agent/evidence like the Python producer", () => {
    const issuer = newKeys();
    const sign = (init: Record<string, unknown>) =>
      buildAerfReceipt({ ...baseInit, ...init } as unknown as typeof baseInit, {
        issuerPrivateKey: issuer.privateKeyPem,
      });
    expect(() => sign({ action: "" })).toThrow(AerfReceiptError);
    expect(() => sign({ action: "x".repeat(129) })).toThrow(/at most 128/);
    expect(() => sign({ agent: "badagent" })).toThrow(/control characters/);
    expect(() =>
      sign({ evidence: 42 as unknown as Record<string, unknown> }),
    ).toThrow(/evidence must be an object/);
  });

  it("refuses an empty previousReceiptHash (genesis must omit, SPEC §8.1)", () => {
    const issuer = newKeys();
    expect(() =>
      buildAerfReceipt(
        { ...baseInit, previousReceiptHash: "" },
        { issuerPrivateKey: issuer.privateKeyPem },
      ),
    ).toThrow(/genesis/);
  });
});

describe("aerfChainHash (SPEC §8.4)", () => {
  it("hashes the stripped payload — signature and post-issuance fields excluded", () => {
    const issuer = newKeys();
    const receipt = buildAerfReceipt(baseInit, { issuerPrivateKey: issuer.privateKeyPem });
    const r = receipt as unknown as Record<string, unknown>;

    expect(aerfChainHash(r)).toBe(sha256Hex(signedPayloadBytes(r)));
    // Adding post-issuance fields does NOT change the chain hash…
    const counterSigned = { ...r, parent_signature: "aa".repeat(64), parent_key_id: "x" };
    expect(aerfChainHash(counterSigned)).toBe(aerfChainHash(r));
    // …but changing a signed field does.
    const mutated = { ...r, action: "submit:claim:OTHER" };
    expect(aerfChainHash(mutated)).not.toBe(aerfChainHash(r));
  });

  it("links a two-receipt chain and matches the conformance-vector rule", () => {
    const issuer = newKeys();
    const genesis = buildAerfReceipt(baseInit, { issuerPrivateKey: issuer.privateKeyPem });
    const second = buildAerfReceipt(
      { ...baseInit, previousReceiptHash: aerfChainHash(genesis as unknown as Record<string, unknown>) },
      { issuerPrivateKey: issuer.privateKeyPem },
    );
    expect(second.previous_receipt_hash).toBe(
      sha256Hex(canonicalBytes({ ...(genesis as unknown as Record<string, unknown>), signature: undefined })),
    );
  });
});

describe("log inclusion round-trip (SPEC §15)", () => {
  it("attaches a proof that verifies, and rejects a tampered path (vectors 09/10 semantics)", () => {
    const issuer = newKeys();
    const log = newKeys();
    const receipts = Array.from({ length: 5 }, (_, i) =>
      buildAerfReceipt(
        { ...baseInit, action: `submit:claim:CLM-${i}` },
        { issuerPrivateKey: issuer.privateKeyPem },
      ),
    ) as unknown as Record<string, unknown>[];

    for (let i = 0; i < receipts.length; i++) {
      const withProof = attachLogInclusionProof(receipts, i, {
        logId: "test-log-001",
        logPrivateKey: log.privateKeyPem,
      });
      const res = verifyAerfReceipt(withProof, {
        issuerPublicKey: issuer.publicKeyPem,
        logPublicKey: log.publicKeyPem,
      });
      expect(res.ok, `leaf ${i}: ${res.failReason}`).toBe(true);
      expect(res.log).toBe("passed");

      // Tampered audit path → log_inclusion failure (vector 10).
      const tampered = {
        ...withProof,
        log_inclusion_proof: {
          ...withProof.log_inclusion_proof,
          audit_path: withProof.log_inclusion_proof.audit_path.map((h, j) =>
            j === 0 ? "0".repeat(64) : h,
          ),
        },
      };
      const bad = verifyAerfReceipt(tampered, {
        issuerPublicKey: issuer.publicKeyPem,
        logPublicKey: log.publicKeyPem,
      });
      expect(bad.ok).toBe(false);
      expect(bad.failCategory).toBe("log_inclusion");
      // The issuer signature is untouched — the proof is post-issuance.
      expect(bad.issuerOk).toBe(true);
    }
  });

  it("rejects an STH signed by the wrong log key", () => {
    const issuer = newKeys();
    const log = newKeys();
    const receipts = [
      buildAerfReceipt(baseInit, { issuerPrivateKey: issuer.privateKeyPem }),
    ] as unknown as Record<string, unknown>[];
    const withProof = attachLogInclusionProof(receipts, 0, {
      logId: "test-log-001",
      logPrivateKey: log.privateKeyPem,
    });
    const res = verifyAerfReceipt(withProof, {
      issuerPublicKey: issuer.publicKeyPem,
      logPublicKey: newKeys().publicKeyPem,
    });
    expect(res.ok).toBe(false);
    expect(res.failReason).toContain("sth signature");
  });
});

describe("verifyAerfReceipt structure checks", () => {
  it("rejects previous_receipt_hash: null / empty (genesis conformance)", () => {
    const issuer = newKeys();
    const receipt = buildAerfReceipt(baseInit, { issuerPrivateKey: issuer.privateKeyPem });
    for (const bad of [null, ""]) {
      const r = { ...(receipt as unknown as Record<string, unknown>), previous_receipt_hash: bad };
      const res = verifyAerfReceipt(r, { issuerPublicKey: issuer.publicKeyPem });
      expect(res.ok).toBe(false);
      expect(res.failCategory).toBe("chain");
    }
  });
});
