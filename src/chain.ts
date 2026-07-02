// Receipt chain verification — the signed-silence guarantee.
//
// Receipts within one plan form a hash chain: each receipt's
// previous_receipt_hash is the SPEC §8.4 chain hash of its predecessor, and
// each receipt carries a signed monotonic seq. A deleted receipt is therefore
// detectable TWO independent ways: the hash link breaks AND the seq gaps.
// Logs can omit; chains cannot.
import type { KeyObject } from "node:crypto";
import { canonicalBytes, sha256Hex } from "./kernel/canonical.js";
import { verifyStripped } from "./kernel/sign.js";
import { aerfChainHash } from "./receipt-aerf.js";

export type ChainBreakType =
  | "signature_invalid"
  | "hash_link_mismatch"
  | "seq_gap"
  | "genesis_violation";

export interface ChainVerification {
  valid: boolean;
  length: number;
  /** Chain hash (§8.4) of the final receipt — the anchoring commitment. */
  rootHash: string;
  /** 0-based index of the first broken receipt, when valid is false. */
  breakAtIndex?: number;
  breakType?: ChainBreakType;
  reason?: string;
  /**
   * Set when the chain verified via the legacy Python link rule (chain hash
   * computed over the payload INCLUDING the signature) rather than SPEC §8.4.
   */
  linkRule?: "aerf-spec" | "python-legacy";
}

export interface VerifyChainOptions {
  /** Issuer public key. When provided, every receipt's signature is checked. */
  issuerPublicKey?: string | KeyObject;
  /**
   * Also accept chains linked with the Python producer's legacy rule
   * (SHA-256 over canonical payload including `signature`). Off by default —
   * SPEC §8.4 is the conformant rule.
   */
  acceptLegacyLinks?: boolean;
}

/** The Python producer's legacy chain hash: canonical payload INCLUDING signature. */
export function legacyChainHash(receipt: Record<string, unknown>): string {
  const { timestamp: _t, ...withSig } = receipt;
  return sha256Hex(canonicalBytes(withSig));
}

/**
 * Verify an ordered receipt chain. Reports the FIRST break with its 0-based
 * index and a distinct break type:
 *
 *  - `signature_invalid`:   a signed field was tampered after issuance
 *  - `hash_link_mismatch`:  a receipt was removed/reordered (hash evidence)
 *  - `seq_gap`:             a receipt was removed (independent seq evidence)
 *  - `genesis_violation`:   the first receipt carries a previous_receipt_hash
 *
 * Signature is checked before links so tampering is named as tampering, not
 * as a broken link. Receipts without a `seq` field skip the seq check
 * (Python-produced chains have no seq).
 */
export function verifyAerfChain(
  receipts: readonly Record<string, unknown>[],
  opts: VerifyChainOptions = {},
): ChainVerification {
  if (receipts.length === 0) return { valid: true, length: 0, rootHash: "" };

  // Decide the link rule once, from the first linked pair (a chain mixes
  // rules only if something is wrong — the per-receipt loop catches that).
  let linkRule: "aerf-spec" | "python-legacy" = "aerf-spec";
  if (opts.acceptLegacyLinks && receipts.length > 1) {
    const declared = receipts[1]!["previous_receipt_hash"];
    if (typeof declared === "string" && declared === legacyChainHash(receipts[0]!)) {
      linkRule = "python-legacy";
    }
  }
  const chainHash = linkRule === "python-legacy" ? legacyChainHash : aerfChainHash;

  const fail = (
    index: number,
    breakType: ChainBreakType,
    reason: string,
  ): ChainVerification => ({
    valid: false,
    length: receipts.length,
    rootHash: "",
    breakAtIndex: index,
    breakType,
    reason,
    linkRule,
  });

  let expectedPrev: string | undefined;
  let prevSeq: number | undefined;

  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]!;

    // 1. Signature — tampering is reported as tampering.
    if (opts.issuerPublicKey) {
      const sig = r["signature"];
      if (typeof sig !== "string" || !verifyStripped(r, opts.issuerPublicKey, sig)) {
        return fail(
          i,
          "signature_invalid",
          `receipt [${i}]: signature verification failed — a signed field was tampered`,
        );
      }
    }

    // 2. Hash link. Genesis must OMIT the field (§8.1).
    const declaredPrev = r["previous_receipt_hash"];
    if (i === 0) {
      if (declaredPrev !== undefined) {
        return fail(
          0,
          "genesis_violation",
          "first receipt carries previous_receipt_hash — genesis must omit the field (SPEC §8.1)",
        );
      }
    } else if (declaredPrev !== expectedPrev) {
      const seqNote = seqOf(r) !== undefined && seqOf(r) !== (prevSeq ?? 0) + 1
        ? ` (seq also gaps: expected ${(prevSeq ?? 0) + 1}, got ${seqOf(r)})`
        : "";
      return fail(
        i,
        "hash_link_mismatch",
        `receipt [${i}]: previous_receipt_hash ${short(declaredPrev)} != expected ` +
          `${short(expectedPrev)} — a receipt was removed or reordered${seqNote}`,
      );
    }

    // 3. Monotonic seq (TS extension; independent deletion evidence).
    const seq = seqOf(r);
    if (seq !== undefined) {
      const expectedSeq = (prevSeq ?? 0) + 1;
      if (prevSeq === undefined && i === 0) {
        // Genesis may start at any seq ≥ 1, but by construction we emit 1.
        if (seq < 1) return fail(i, "seq_gap", `receipt [0]: seq ${seq} < 1`);
      } else if (seq !== expectedSeq) {
        return fail(
          i,
          "seq_gap",
          `receipt [${i}]: seq gap — expected ${expectedSeq}, got ${seq} — a receipt was removed`,
        );
      }
      prevSeq = seq;
    }

    expectedPrev = chainHash(r);
  }

  return { valid: true, length: receipts.length, rootHash: expectedPrev ?? "", linkRule };
}

function seqOf(r: Record<string, unknown>): number | undefined {
  const seq = r["seq"];
  return typeof seq === "number" && Number.isSafeInteger(seq) ? seq : undefined;
}

function short(h: unknown): string {
  if (typeof h !== "string") return `<${h === undefined ? "absent" : String(h)}>`;
  return h.slice(0, 12) + "…";
}

/**
 * Sign a chain-root commitment (mirrors the Python producer's chain_root
 * object in receipt_index.json). Publishing this externally anchors the
 * entire chain.
 */
export function chainRootCommitment(planId: string, verification: ChainVerification): Record<string, unknown> {
  return {
    type: "chain_root",
    root_hash: verification.rootHash,
    length: verification.length,
    plan_id: planId,
  };
}
