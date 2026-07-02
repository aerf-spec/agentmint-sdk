// Signed decision receipts — one Ed25519-signed, hash-chained receipt per
// enforce() decision. The receipt records WHAT was decided (action, in/out of
// policy, reason) and a HASH of the params, never the raw params. The chain
// makes a deleted decision detectable: a missing receipt breaks both the
// previous_receipt_hash link and the monotonic seq.
import { randomUUID, createPublicKey, type KeyObject } from "node:crypto";
import type {
  AgentMintSpec,
  DecisionReceipt,
  Event,
  EventResult,
  ReceiptChainVerification,
} from "./types.js";
import { canonicalBytes, canonicalizeLoose, sha256Hex } from "./kernel/canonical.js";
import {
  privateKeyFromPem,
  publicKeyToPem,
  keyId,
  signStripped,
  verifyStripped,
} from "./kernel/sign.js";

/** Results that count as "in policy" — the action was permitted to run. */
const IN_POLICY_RESULTS: ReadonlySet<EventResult> = new Set(["allowed", "approved"]);

/**
 * Mutable signing context threaded across a run. Holds the issuer key material,
 * the (optional) spec hash, and the running chain state (seq + previous hash).
 */
export interface DecisionContext {
  runId: string;
  privateKey: KeyObject;
  publicKeyPem: string;
  keyId: string;
  specHash?: string;
  /** Last seq assigned (0 before any receipt). Mutated by buildDecisionReceipt. */
  seq: number;
  /** Hash of the previous receipt (incl. its signature). Undefined at genesis. */
  previousHash?: string;
  /** Every receipt emitted so far, in order. */
  receipts: DecisionReceipt[];
}

/** Build a signing context from a PEM private key and optional spec. */
export function createDecisionContext(opts: {
  runId: string;
  privateKeyPem: string;
  spec?: AgentMintSpec;
}): DecisionContext {
  const privateKey = privateKeyFromPem(opts.privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  return {
    runId: opts.runId,
    privateKey,
    publicKeyPem: publicKeyToPem(publicKey),
    keyId: keyId(publicKey),
    // Loose canonicalization: a spec is a policy document that may carry
    // fractional USD cost estimates, which strict (signed-payload) canonical
    // JSON forbids. This hash is a stable policy identity, not a signed payload.
    specHash: opts.spec
      ? sha256Hex(Buffer.from(canonicalizeLoose(opts.spec), "utf-8"))
      : undefined,
    seq: 0,
    previousHash: undefined,
    receipts: [],
  };
}

/** Compose a human-readable policy reason from an event's reason + details. */
function policyReasonFor(event: Event): string {
  const reason = event.reason;
  const details = event.details;
  if (reason && details) return `${reason}: ${details}`;
  if (reason) return reason;
  if (details) return details;
  // Guarantee a non-empty, human-readable reason for every non-allowed result.
  return event.result;
}

/**
 * Build, sign, and chain one decision receipt for a logged event. Mutates the
 * context: advances seq, appends to receipts, and updates previousHash to this
 * receipt's canonical hash (including its signature) for the next link.
 */
export function buildDecisionReceipt(event: Event, ctx: DecisionContext): DecisionReceipt {
  const seq = ++ctx.seq;
  const inPolicy = IN_POLICY_RESULTS.has(event.result);

  // Assemble the signable body. previous_receipt_hash is part of the signed
  // payload; on genesis the key is omitted entirely (never null).
  const receipt: DecisionReceipt = {
    id: randomUUID(),
    run_id: ctx.runId,
    seq,
    action: event.tool,
    params_hash: sha256Hex(canonicalBytes(event.params ?? {})),
    in_policy: inPolicy,
    policy_reason: policyReasonFor(event),
    ...(ctx.specHash !== undefined ? { spec_hash: ctx.specHash } : {}),
    observed_at: event.timestamp,
    key_id: ctx.keyId,
    ...(ctx.previousHash !== undefined ? { previous_receipt_hash: ctx.previousHash } : {}),
    // signature filled in below
    signature: "",
  };

  receipt.signature = signStripped(
    receipt as unknown as Record<string, unknown>,
    ctx.privateKey,
  );

  // Advance the chain: the next receipt's previous_receipt_hash is the SHA-256
  // of THIS receipt's canonical bytes INCLUDING its signature.
  ctx.previousHash = sha256Hex(canonicalBytes(receipt as unknown as Record<string, unknown>));
  ctx.receipts.push(receipt);
  return receipt;
}

/**
 * Verify a chain of decision receipts: every signature, every chain link, and
 * the monotonic 1-based seq. A REMOVED receipt is caught by BOTH a broken
 * previous_receipt_hash link and a seq gap. Returns the first break (0-based).
 */
export function verifyDecisionReceipts(
  receipts: readonly DecisionReceipt[],
  publicKeyPem: string,
): ReceiptChainVerification {
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]!;

    // 1. Signature over the stripped, canonical receipt.
    if (!verifyStripped(r as unknown as Record<string, unknown>, publicKeyPem, r.signature)) {
      return {
        ok: false,
        brokenAt: i,
        reason: `Receipt [${i}] (seq ${r.seq}): signature verification failed — a signed field was tampered.`,
      };
    }

    // 2. Chain link: previous_receipt_hash must equal the prior receipt's hash.
    const expectedPrev =
      i === 0 ? undefined : sha256Hex(canonicalBytes(receipts[i - 1] as unknown as Record<string, unknown>));
    const actualPrev = r.previous_receipt_hash;
    if (actualPrev !== expectedPrev) {
      const seqGap = r.seq !== i + 1 ? ` (seq gap: expected ${i + 1}, got ${r.seq})` : "";
      return {
        ok: false,
        brokenAt: i,
        reason:
          `Receipt [${i}] missing: chain expected prev_hash ` +
          `[${(expectedPrev ?? "<genesis:absent>").slice(0, 12)}...], got ` +
          `[${(actualPrev ?? "<absent>").slice(0, 12)}...]${seqGap} — a decision was deleted. ` +
          `Logs can omit; chains cannot.`,
      };
    }

    // 3. Monotonic 1-based seq (also catches a removal at the tail).
    if (r.seq !== i + 1) {
      return {
        ok: false,
        brokenAt: i,
        reason: `Receipt [${i}]: seq gap — expected ${i + 1}, got ${r.seq}. A decision was deleted.`,
      };
    }
  }
  return { ok: true };
}
