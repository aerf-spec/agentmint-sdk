// filet-signer: the only Worker that holds ISSUER_PRIVATE_KEY.
// No public route (workers_dev = false, no routes); filet-call reaches it over a
// service binding (RPC). It computes key_id and evidence_hash_sha512 itself,
// canonicalizes (byte-identical to the SDK) and signs, so the caller never
// touches key material.

import { WorkerEntrypoint } from "cloudflare:workers";
import { batchMessage, canonicalBytes, edSign, loadPrivateKey, logLeafHash, sha256Hex, sha512Hex, signedPayloadBytes } from "../../../shared/canonical";

export interface Env {
  ISSUER_PRIVATE_KEY?: string;
}

type Loaded = Awaited<ReturnType<typeof loadPrivateKey>>;
let cached: Promise<Loaded> | undefined;
function key(env: Env): Promise<Loaded> {
  if (!env.ISSUER_PRIVATE_KEY) return Promise.reject(new Error("ISSUER_PRIVATE_KEY not configured"));
  cached ??= loadPrivateKey(env.ISSUER_PRIVATE_KEY).catch((e) => {
    cached = undefined;
    throw e;
  });
  return cached;
}

// Fields the caller may set. key_id, evidence_hash_sha512 and signature are the signer's.
const ALLOWED = new Set([
  "id", "type", "plan_id", "agent", "action", "in_policy", "policy_reason", "evidence", "observed_at",
  "aiuc_controls", "agent_key_id", "policy_hash", "session_id", "reasoning_hash", "previous_receipt_hash",
  "seq", "commitment_alg", "context_hash_sha256", "compliance_tags",
]);

export default class Signer extends WorkerEntrypoint<Env> {
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  }

  async info(): Promise<{ public_key_pem: string; key_id: string }> {
    const k = await key(this.env);
    return { public_key_pem: k.publicPem, key_id: k.keyId };
  }

  async signReceipt(fields: Record<string, unknown>): Promise<{
    receipt: Record<string, unknown>;
    receipt_hash: string;
    leaf_hash: string;
    sign_us: number;
    hot_us: number;
  }> {
    const h0 = performance.now();
    for (const f of Object.keys(fields)) if (!ALLOWED.has(f)) throw new Error(`field not allowed: ${f}`);
    const k = await key(this.env);
    const evidence = fields.evidence as Record<string, unknown>;
    const signable: Record<string, unknown> = {
      ...fields,
      evidence_hash_sha512: await sha512Hex(canonicalBytes(evidence)),
      key_id: k.keyId,
    };
    const payload = signedPayloadBytes(signable);
    const s0 = performance.now();
    const signature = await edSign(k.key, payload);
    const s1 = performance.now();
    const receipt = { ...signable, signature };
    return {
      receipt,
      receipt_hash: await sha256Hex(payload),
      leaf_hash: await logLeafHash(payload),
      // Workers freezes the clock during CPU work (Spectre mitigation), so these
      // read 0 unless I/O happened; filet-call reports the measured RPC time.
      sign_us: Math.round((s1 - s0) * 1000),
      hot_us: Math.round((performance.now() - h0) * 1000),
    };
  }

  /** Ed25519 over SHA-256(concat(raw leaves) || utf8(batch_ts)), the authority's batch format. */
  async signBatch(leafHashes: string[], batchTs: string): Promise<{ batch_signature: string; key_id: string }> {
    if (!Array.isArray(leafHashes) || leafHashes.length === 0 || leafHashes.length > 1024) throw new Error("bad batch");
    if (!leafHashes.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h))) throw new Error("bad leaf");
    const k = await key(this.env);
    return { batch_signature: await edSign(k.key, await batchMessage(leafHashes, batchTs)), key_id: k.keyId };
  }
}
