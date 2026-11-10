import { createHash } from "node:crypto";
import type { MerkleProof } from "./types.js";

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ── RFC 6962 primitives (domain-separated hashing) ──────────────────
// These mirror the Go reference verifier's LogLeafHash / hashInternal /
// walkAuditPath exactly. Domain separation (0x00 leaf / 0x01 interior)
// prevents an interior node from being presented as a leaf.

/** RFC 6962 leaf hash: SHA-256(0x00 || data), lowercase hex. */
export function logLeafHash(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return createHash("sha256").update(Buffer.from([0x00])).update(bytes).digest("hex");
}

/** RFC 6962 interior hash: SHA-256(0x01 || left || right), hex in/out. */
export function hashInternal(leftHex: string, rightHex: string): string {
  return createHash("sha256")
    .update(Buffer.from([0x01]))
    .update(Buffer.from(leftHex, "hex"))
    .update(Buffer.from(rightHex, "hex"))
    .digest("hex");
}

/**
 * Recompute the root from a leaf hash and an RFC 6962 inclusion proof,
 * following RFC 9162 §2.1.3.2 exactly. Returns "" for a structurally invalid
 * proof (wrong path length for the index/size), which can never equal a root.
 *
 * Agrees with the Go reference verifier's walkAuditPath on every conformance
 * vector; where they differ is Go's right-edge promote branch, which consumes
 * a path entry without hashing it and rejects valid standard proofs for the
 * last leaf of a non-power-of-two tree. Standard semantics win here (the
 * reference proof BUILDER in the aerf repo emits standard RFC 6962 paths).
 */
export function walkAuditPath(
  leafHashHex: string,
  pathHex: readonly string[],
  leafIndex: number,
  treeSize: number,
): string {
  if (leafIndex < 0 || treeSize < 1 || leafIndex >= treeSize) return "";
  let fn = leafIndex;
  let sn = treeSize - 1;
  let r = leafHashHex;
  for (const p of pathHex) {
    if (sn === 0) return "";
    if (fn % 2 === 1 || fn === sn) {
      r = hashInternal(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = hashInternal(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 ? r : "";
}

// Canonical JSON is the kernel's single implementation; re-exported here so
// evidence leaves and arg hashes share the exact bytes the wedge signs over.
export { canonicalize } from "./kernel/canonical.js";

// ── RFC 6962 Merkle tree ────────────────────────────────────────────
//
// Correct RFC 6962 semantics throughout (matching the AERF reference
// primitives in the aerf repo's tools/aerf_primitives.py and the Go
// verifier's leaf/interior hashes):
//
//  - leaf hash     = SHA-256(0x00 || data)
//  - interior hash = SHA-256(0x01 || left || right)
//  - split rule: the left subtree holds the largest power of two < n
//    leaves; NO padding leaves are ever inserted
//  - inclusion proofs are standard RFC 6962 audit paths, verifiable by
//    walkAuditPath and by any RFC 9162 checker
//
// Domain separation makes second-preimage splicing impossible: an interior
// node's bytes hash differently as a leaf (0x00 prefix) than as an interior
// node (0x01 prefix), so a subtree cannot be presented as a single leaf.

/** MTH of a slice of leaf HASHES (hex), per RFC 6962 §2.1. */
function merkleRoot(leafHashes: readonly string[]): string {
  if (leafHashes.length === 0) return sha256("");
  if (leafHashes.length === 1) return leafHashes[0]!;
  const mid = largestPowerOfTwoBelow(leafHashes.length);
  return hashInternal(merkleRoot(leafHashes.slice(0, mid)), merkleRoot(leafHashes.slice(mid)));
}

/** Largest power of two strictly less than n (n >= 2). */
function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** RFC 6962 audit path (sibling hashes leaf→root) with positions. */
function auditPathWithPositions(
  leafHashes: readonly string[],
  index: number,
): Array<{ hash: string; position: "left" | "right" }> {
  if (leafHashes.length <= 1) return [];
  const mid = largestPowerOfTwoBelow(leafHashes.length);
  if (index < mid) {
    return [
      ...auditPathWithPositions(leafHashes.slice(0, mid), index),
      { hash: merkleRoot(leafHashes.slice(mid)), position: "right" },
    ];
  }
  return [
    ...auditPathWithPositions(leafHashes.slice(mid), index - mid),
    { hash: merkleRoot(leafHashes.slice(0, mid)), position: "left" },
  ];
}

export class MerkleTree {
  private leaves: string[] = [];

  /** Append a leaf; stores SHA-256(0x00 || data). Returns the leaf index. */
  addLeaf(data: string | Uint8Array): number {
    this.leaves.push(logLeafHash(data));
    return this.leaves.length - 1;
  }

  /**
   * Append a precomputed RFC 6962 leaf hash (SHA-256(0x00 || data), 64
   * lowercase hex), e.g. one produced by {@link logLeafHash} elsewhere.
   * Returns the leaf index. Throws TypeError on any other input.
   */
  addLeafHash(leafHashHex: string): number {
    if (typeof leafHashHex !== "string" || !/^[0-9a-f]{64}$/.test(leafHashHex)) {
      throw new TypeError("leaf hash must be 64 lowercase hex characters");
    }
    this.leaves.push(leafHashHex);
    return this.leaves.length - 1;
  }

  /** Number of leaves appended so far. */
  get leafCount(): number {
    return this.leaves.length;
  }

  /** Compute the RFC 6962 root. Empty tree hashes to SHA-256(""). */
  build(): string {
    return merkleRoot(this.leaves);
  }

  /** Standard RFC 6962 inclusion proof for the leaf at `index`. */
  getProof(leafIndex: number): MerkleProof {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new RangeError(`leaf index ${leafIndex} out of range [0, ${this.leaves.length})`);
    }
    return {
      leaf: this.leaves[leafIndex]!,
      index: leafIndex,
      siblings: auditPathWithPositions(this.leaves, leafIndex),
      root: this.build(),
    };
  }

  /** Bare RFC 6962 audit path (hashes only), e.g. for a log_inclusion_proof. */
  auditPath(leafIndex: number): string[] {
    return this.getProof(leafIndex).siblings.map((s) => s.hash);
  }

  static verify(proof: MerkleProof): boolean {
    let hash = proof.leaf;
    for (const sibling of proof.siblings) {
      hash =
        sibling.position === "left"
          ? hashInternal(sibling.hash, hash)
          : hashInternal(hash, sibling.hash);
    }
    return hash === proof.root;
  }
}
