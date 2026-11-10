import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createPublicKey, sign as edSign } from "node:crypto";
import { Authority, batchDigest, type BatchResponse } from "./authority.js";
import { verifyConsistency } from "./log.js";
import { buildAerfReceipt, verifyAerfReceipt, verifyLogInclusionProof } from "../src/receipt-aerf.js";
import { generateKeyPair, publicKeyToPem, signedPayloadBytes } from "../src/kernel/sign.js";
import { logLeafHash } from "../src/merkle.js";

function issuer() {
  const k = generateKeyPair();
  return { ...k, pem: publicKeyToPem(k.publicKey) };
}

function receipts(key: ReturnType<typeof issuer>, n: number, from = 0) {
  return Array.from({ length: n }, (_, i) =>
    buildAerfReceipt(
      { planId: "p", agent: "a", action: `decide:${from + i}`, inPolicy: true, policyReason: "ok", evidence: { n: from + i }, seq: from + i + 1 },
      { issuerPrivateKey: key.privateKey },
    ) as unknown as Record<string, unknown>,
  );
}

function batch(auth: Authority, key: ReturnType<typeof issuer>, keyId: string, rs: Record<string, unknown>[]): BatchResponse {
  const leaf_hashes = rs.map((r) => logLeafHash(signedPayloadBytes(r)));
  const batch_signature = edSign(null, batchDigest(leaf_hashes), key.privateKey).toString("hex");
  return auth.appendBatch({ key_id: keyId, leaf_hashes, batch_signature });
}

describe("Authority", () => {
  it("returns one STH per batch and inclusion proofs the SDK verifier accepts unchanged", () => {
    const auth = new Authority();
    const key = issuer();
    const kid = auth.registerIssuer(key.pem);
    const first = receipts(key, 3);
    const second = receipts(key, 5, 3);
    const b1 = batch(auth, key, kid, first);
    const b2 = batch(auth, key, kid, second);
    expect(b1.tree_size_before).toBe(0);
    expect(b2.tree_size_before).toBe(3);
    expect(b2.sth.tree_size).toBe(8);
    expect(new Set(b2.proofs.map((p) => p.sth_signature)).size).toBe(1); // one signed head per batch
    const logPub = createPublicKey(auth.publicKeyPem);
    for (const [rs, b] of [[first, b1], [second, b2]] as const) {
      rs.forEach((r, i) => {
        const anchored = { ...r, log_inclusion_proof: b.proofs[i] };
        expect(verifyLogInclusionProof(r, b.proofs[i] as unknown as Record<string, unknown>, logPub)).toBeUndefined();
        const v = verifyAerfReceipt(anchored, { issuerPublicKey: key.pem, logPublicKey: auth.publicKeyPem, requireLog: true });
        expect(v.ok, v.failReason).toBe(true);
        expect(v.log).toBe("passed");
      });
    }
  });

  it("a tampered receipt fails verification against its proof", () => {
    const auth = new Authority();
    const key = issuer();
    const kid = auth.registerIssuer(key.pem);
    const rs = receipts(key, 4);
    const b = batch(auth, key, kid, rs);
    const tampered = { ...rs[2]!, in_policy: false, log_inclusion_proof: b.proofs[2] };
    const v = verifyAerfReceipt(tampered, { issuerPublicKey: key.pem, logPublicKey: auth.publicKeyPem });
    expect(v.ok).toBe(false);
    // Even with the issuer check skipped, the log leaf no longer matches.
    expect(verifyLogInclusionProof(tampered, b.proofs[2] as unknown as Record<string, unknown>, createPublicKey(auth.publicKeyPem))).toMatch(/leaf_hash/);
    // A proof for a different leaf does not transfer.
    expect(verifyLogInclusionProof(rs[1]!, b.proofs[2] as unknown as Record<string, unknown>, createPublicKey(auth.publicKeyPem))).toBeDefined();
  });

  it("rejects a wrong batch signature and an unknown issuer", () => {
    const auth = new Authority();
    const key = issuer();
    const other = issuer();
    const kid = auth.registerIssuer(key.pem);
    const leaf_hashes = receipts(key, 2).map((r) => logLeafHash(signedPayloadBytes(r)));
    const wrong = edSign(null, batchDigest(leaf_hashes), other.privateKey).toString("hex");
    expect(() => auth.appendBatch({ key_id: kid, leaf_hashes, batch_signature: wrong })).toThrow(/batch_signature/);
    const reordered = edSign(null, batchDigest([...leaf_hashes].reverse()), key.privateKey).toString("hex");
    expect(() => auth.appendBatch({ key_id: kid, leaf_hashes, batch_signature: reordered })).toThrow(/batch_signature/);
    expect(() => auth.appendBatch({ key_id: "0000000000000000", leaf_hashes, batch_signature: wrong })).toThrow(/unknown issuer/);
    expect(auth.log.size).toBe(0);
  });

  it("serves the CONTRACT HTTP API; consistency proofs verify between two STHs", async () => {
    const auth = new Authority();
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      void auth.handle(req, res, u.pathname.replace(/^\/authority/, ""), u.searchParams);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/authority`;
    try {
      const key = issuer();
      const keyRes = (await (await fetch(`${base}/v1/key`)).json()) as { log_id: string; public_key_pem: string };
      expect(keyRes.log_id).toMatch(/^filet-log-[0-9a-f]{16}$/);
      const reg = await fetch(`${base}/v1/issuers`, { method: "POST", body: JSON.stringify({ public_key_pem: key.pem }) });
      const { key_id } = (await reg.json()) as { key_id: string };
      const post = async (rs: Record<string, unknown>[]) => {
        const leaf_hashes = rs.map((r) => logLeafHash(signedPayloadBytes(r)));
        const batch_signature = edSign(null, batchDigest(leaf_hashes), key.privateKey).toString("hex");
        const r = await fetch(`${base}/v1/batches`, { method: "POST", body: JSON.stringify({ key_id, leaf_hashes, batch_signature }) });
        expect(r.status).toBe(200);
        return (await r.json()) as BatchResponse;
      };
      const a = await post(receipts(key, 3));
      const b = await post(receipts(key, 6, 3));
      const sth = (await (await fetch(`${base}/v1/sth`)).json()) as { sth: { tree_size: number } };
      expect(sth.sth.tree_size).toBe(9);
      const c = (await (await fetch(`${base}/v1/consistency?from=3&to=9`)).json()) as { proof: string[] };
      expect(verifyConsistency(3, 9, a.sth.root_hash, b.sth.root_hash, c.proof)).toBe(true);
      expect(verifyConsistency(3, 9, b.sth.root_hash, b.sth.root_hash, c.proof)).toBe(false);
      expect((await fetch(`${base}/v1/consistency?from=5&to=99`)).status).toBe(400);
      const bad = await fetch(`${base}/v1/batches`, { method: "POST", body: JSON.stringify({ key_id, leaf_hashes: ["00".repeat(32)], batch_signature: "00".repeat(64) }) });
      expect(bad.status).toBe(403);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
